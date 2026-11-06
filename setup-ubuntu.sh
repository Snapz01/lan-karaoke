#!/usr/bin/env bash
# LAN Karaoke – installer för Ubuntu 22.04/24.04 (MSI Cubi N 8GL / Intel UHD 600)
# Kör från projektmappen:  sudo ./setup-ubuntu.sh
# Valfria miljövariabler:  KARAOKE_PIN=1234  AUTOLOGIN=1  INSTALL_DIR=/opt/lan-karaoke  PORT=3000
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Kör med sudo: sudo ./setup-ubuntu.sh"; exit 1; }
TARGET_USER="${SUDO_USER:-}"
[[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]] || { echo "Kör via sudo från det vanliga skrivbordskontot (inte som root direkt)."; exit 1; }
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/lan-karaoke}"
PORT="${PORT:-3000}"
ARCH="$(uname -m)"

log() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

# ───────────────────────────── Paket ─────────────────────────────
log "Installerar systempaket"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg rsync ffmpeg fonts-noto-color-emoji fonts-dejavu-core
# Valfria paket: namn skiljer mellan Ubuntu-versioner – ett saknat paket ska inte stoppa installationen
for pkg in fonts-noto-core intel-media-va-driver vainfo x11-xserver-utils pulseaudio-utils unclutter-xfixes unclutter; do
  apt-get install -y --no-install-recommends "$pkg" >/dev/null 2>&1 && echo "  ✓ $pkg" || echo "  – $pkg (hoppades över)"
done

# ───────────────────────────── Node.js ≥ 20 ─────────────────────────────
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 20 ]] && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  log "Installerar Node.js 22 LTS (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "Node: $($NODE_BIN -v)"

# ───────────────────────────── yt-dlp (officiell binär) ─────────────────────────────
# Ubuntu-paketet är för gammalt för YouTube. Den fristående binären innehåller yt-dlp-ejs;
# YouTube kräver dessutom en JS-runtime → Node används via --js-runtimes node.
log "Installerar senaste yt-dlp"
case "$ARCH" in
  x86_64) YTDLP_ASSET="yt-dlp_linux" ;;
  aarch64) YTDLP_ASSET="yt-dlp_linux_aarch64" ;;
  *) YTDLP_ASSET="yt-dlp" ;;
esac
curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" -o /usr/local/bin/yt-dlp.new
chmod 755 /usr/local/bin/yt-dlp.new
mv /usr/local/bin/yt-dlp.new /usr/local/bin/yt-dlp
/usr/local/bin/yt-dlp --version

cat >/etc/systemd/system/yt-dlp-update.service <<EOF
[Unit]
Description=Uppdatera yt-dlp
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/yt-dlp -U
EOF
cat >/etc/systemd/system/yt-dlp-update.timer <<EOF
[Unit]
Description=Uppdatera yt-dlp dagligen
[Timer]
OnBootSec=5min
OnUnitActiveSec=1d
Persistent=true
[Install]
WantedBy=timers.target
EOF

# ───────────────────────────── Webbläsare ─────────────────────────────
log "Kontrollerar Chromium"
BROWSER=""
for b in google-chrome-stable google-chrome chromium chromium-browser; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$(command -v "$b")"; break; fi
done
if [[ -z "$BROWSER" ]]; then
  # På Ubuntu ≥ 20.04 är chromium-browser ett övergångspaket till snap
  if command -v snap >/dev/null 2>&1; then snap install chromium; else apt-get install -y chromium-browser; fi
  BROWSER="$(command -v chromium || command -v chromium-browser || echo /snap/bin/chromium)"
fi
echo "Webbläsare: $BROWSER"
# Kiosken ska inte uppdateras mitt under en fest – uppdatera manuellt: sudo snap refresh chromium
if [[ "$BROWSER" == /snap/* ]] && command -v snap >/dev/null 2>&1; then snap refresh --hold=forever chromium >/dev/null 2>&1 || true; fi

# ───────────────────────────── Applikation ─────────────────────────────
log "Kopierar applikationen till $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
  --exclude node_modules --exclude media --exclude data --exclude .git \
  "$SRC_DIR"/ "$INSTALL_DIR"/
mkdir -p "$INSTALL_DIR/media" "$INSTALL_DIR/data"
chown -R "$TARGET_USER":"$TARGET_USER" "$INSTALL_DIR"
sudo -u "$TARGET_USER" -H bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"

# ───────────────────────────── Konfiguration ─────────────────────────────
ENV_FILE=/etc/default/lan-karaoke
TARGET_UID="$(id -u "$TARGET_USER")"
if [[ ! -f "$ENV_FILE" ]]; then
  PIN="${KARAOKE_PIN:-}"
  if [[ -z "$PIN" && -t 0 ]]; then
    read -rp "Valfri PIN för ⚙️ Avancerat (lämna tomt = ingen PIN): " PIN || true
  fi
  cat >"$ENV_FILE" <<EOF
# LAN Karaoke – ändra och kör: sudo systemctl restart lan-karaoke
PORT=$PORT
KARAOKE_PIN=$PIN
MEDIA_DIR=$INSTALL_DIR/media
DATA_DIR=$INSTALL_DIR/data
YTDLP_BIN=/usr/local/bin/yt-dlp
YTDLP_ARGS="--js-runtimes node:$NODE_BIN"
CACHE_MAX_GB=10
MIN_FREE_GB=1
MAX_PARALLEL_JOBS=2
TARGET_LUFS=-16
COVERS_ONLINE=1
KIOSK_AUTO_HDMI=1
# Uppdatering från värdpanelen (http://localhost:$PORT/host): UPDATE_REPO=ditt-github-namn/lan-karaoke
UPDATE_REPO=
UPDATE_BRANCH=main
# UPDATE_TOKEN=   # bara för privat repo (fine-grained token, läsrätt till Contents)
# YTDLP_COOKIES=$INSTALL_DIR/data/cookies.txt   # laddas även upp via mobilen
# PUBLIC_HOST=192.168.1.50   # tvinga IP/värdnamn i QR-koden
EOF
  chmod 640 "$ENV_FILE"
  chgrp "$TARGET_USER" "$ENV_FILE"
fi

# Wi-Fi-QR på TV:n (gäster ansluter med en skanning). Frågas bara om det inte redan är satt.
if ! grep -q '^WIFI_SSID=' "$ENV_FILE"; then
  SSID="${WIFI_SSID:-}"; WPASS="${WIFI_PASSWORD:-}"
  if [[ -z "$SSID" && -t 0 ]]; then
    read -rp "Wi-Fi-namn för gäst-QR på TV:n (tomt = hoppa över): " SSID || true
    [[ -n "$SSID" ]] && { read -rp "Wi-Fi-lösenord: " WPASS || true; }
  fi
  if [[ -n "$SSID" ]]; then
    q() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }   # citera för systemd EnvironmentFile
    printf '\n# Wi-Fi-QR (visas i TV:ns vänteläge)\nWIFI_SSID="%s"\nWIFI_PASSWORD="%s"\nWIFI_SHOW_PASSWORD=1\n' "$(q "$SSID")" "$(q "$WPASS")" >>"$ENV_FILE"
  fi
fi

# ───────────────────────────── systemd-tjänst ─────────────────────────────
log "Skapar systemd-tjänst"
cat >/etc/systemd/system/lan-karaoke.service <<EOF
[Unit]
Description=LAN Karaoke server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
Group=$TARGET_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
# Når skrivbordsanvändarens PipeWire/PulseAudio (pactl) för val av ljudutgång
Environment=XDG_RUNTIME_DIR=/run/user/$TARGET_UID
ExecStart=$NODE_BIN $INSTALL_DIR/server.js
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF

# ───────────────────────────── Kiosk-launcher ─────────────────────────────
log "Skapar kiosk-launcher och autostart"
cat >/usr/local/bin/karaoke-kiosk <<EOF
#!/usr/bin/env bash
# Startar TV-vyn i helskärm. Avsluta loopen med: pkill -f karaoke-kiosk
BROWSER="$BROWSER"
URL="http://localhost:$PORT/tv"
EOF
cat >>/usr/local/bin/karaoke-kiosk <<'EOF'
[[ -f "$HOME/.config/karaoke-kiosk.disabled" ]] && exit 0
# Vid inloggning startar kiosken bara om "Starta med datorn" är påslaget i värdpanelen (av som standard)
if [[ "${1:-}" == "--autostart" && ! -f "$HOME/.config/karaoke-kiosk.autostart" ]]; then exit 0; fi
pgrep -f -- "--kiosk http://localhost" >/dev/null && exit 0   # redan igång
BASE="${URL%/tv}"
# PIN och inställningar (filen är läsbar för skrivbordsanvändarens grupp)
[[ -r /etc/default/lan-karaoke ]] && . /etc/default/lan-karaoke

# Vänta på servern (max 90 s)
for _ in $(seq 1 90); do curl -fs "$BASE/api/info" >/dev/null 2>&1 && break; sleep 1; done

# Ljudutgång: återställ utgången som valts i värdpanelen (HDMI om inget valts). Servern byter kortprofil och flyttar strömmar.
# KIOSK_AUTO_HDMI=0 stänger av återställningen helt (namnet behållet för bakåtkompatibilitet).
select_hdmi() {
  [[ "${KIOSK_AUTO_HDMI:-1}" == "1" ]] || return 0
  curl -fs -X POST -H 'content-type: application/json' -H "x-karaoke-pin: ${KARAOKE_PIN:-}" -d '{"restore":true}' "$BASE/api/system/audio" >/dev/null 2>&1 || true
}
select_hdmi
( sleep 25; select_hdmi ) &   # TV:n kan vakna efter datorn

# Ingen skärmsläckare/låsning/strömsparläge
if command -v gsettings >/dev/null 2>&1; then
  gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
  gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
  gsettings set org.gnome.desktop.screensaver idle-activation-enabled false 2>/dev/null || true
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
  gsettings set org.gnome.desktop.notifications show-banners false 2>/dev/null || true
fi
if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]] && command -v xset >/dev/null 2>&1; then
  xset s off -dpms s noblank 2>/dev/null || true
  command -v unclutter >/dev/null 2>&1 && (unclutter -idle 1 -root >/dev/null 2>&1 &)
fi

# Snap-Chromium får inte skriva till dolda kataloger i $HOME
if [[ "$BROWSER" == /snap/* ]]; then PROFILE="$HOME/snap/chromium/common/karaoke-kiosk"; else PROFILE="$HOME/.config/karaoke-kiosk"; fi
mkdir -p "$PROFILE"
# Undvik "Chromium stängdes oväntat"-bubblan
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PROFILE/Default/Preferences" 2>/dev/null || true

FLAGS=(
  --kiosk "$URL"
  --autoplay-policy=no-user-gesture-required
  --user-data-dir="$PROFILE"
  --no-first-run --noerrdialogs --disable-infobars --disable-session-crashed-bubble
  --disable-translate --disable-features=Translate,TranslateUI,MediaRouter
  --password-store=basic --check-for-update-interval=31536000
  --overscroll-history-navigation=0 --disable-pinch
  --ignore-gpu-blocklist --enable-gpu-rasterization
  --enable-features=AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,VaapiVideoDecoder
)

# Watchdog: om TV-sidan slutar skicka hjärtslag (fryst renderare/GPU-häng) dödas webbläsaren → loopen startar om den
watchdog() {
  local misses=0 info ago
  sleep 120
  while true; do
    sleep 20
    info="$(curl -fs "$BASE/api/health" 2>/dev/null)" || { misses=0; continue; }   # servern nere ≠ webbläsarfel
    ago="$(sed -n 's/.*"tvBeatAgoMs":\([0-9]*\).*/\1/p' <<<"$info")"
    if [[ "$info" != *'"tvConnected":true'* || -z "$ago" || "$ago" -gt 60000 ]]; then misses=$((misses + 1)); else misses=0; fi
    if (( misses >= 3 )); then
      logger -t karaoke-kiosk "TV-sidan svarar inte – startar om webbläsaren"
      pkill -f -- "--user-data-dir=$PROFILE" || true
      misses=0
      sleep 90
    fi
  done
}
watchdog &
WATCHDOG_PID=$!
trap 'kill $WATCHDOG_PID 2>/dev/null' EXIT

# Starta om webbläsaren om den kraschar
while true; do
  "$BROWSER" "${FLAGS[@]}" >/dev/null 2>&1
  [[ -f "$HOME/.config/karaoke-kiosk.disabled" ]] && exit 0
  sleep 3
done
EOF
chmod 755 /usr/local/bin/karaoke-kiosk

AUTOSTART_DIR="$TARGET_HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat >"$AUTOSTART_DIR/karaoke-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=LAN Karaoke Kiosk
Comment=Startar karaoke-TV-vyn i helskärm
Exec=/usr/local/bin/karaoke-kiosk --autostart
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
NoDisplay=false
EOF
chown -R "$TARGET_USER":"$TARGET_USER" "$TARGET_HOME/.config"

# Menygenväg för att starta TV-vyn manuellt (när autostart är avstängt)
mkdir -p "$TARGET_HOME/.local/share/applications"
cat >"$TARGET_HOME/.local/share/applications/karaoke-tv.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Karaoke TV
Comment=Starta karaoke-TV-vyn i helskärm
Exec=/usr/local/bin/karaoke-kiosk
Icon=$INSTALL_DIR/public/icon-192.png
Terminal=false
Categories=AudioVideo;
DESKTOP

# Genväg till värdpanelen på karaokedatorn (eget fönster, växla med Alt+Tab)
APPS_DIR="$TARGET_HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
if [[ "$BROWSER" == /snap/* ]]; then HOST_PROFILE="$TARGET_HOME/snap/chromium/common/karaoke-host"; else HOST_PROFILE="$TARGET_HOME/.config/karaoke-host"; fi
cat >"$APPS_DIR/karaoke-host.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Karaoke Värdpanel
Comment=Inställningar, bibliotek, system och uppdatering
Exec=$BROWSER --app=http://localhost:$PORT/host --user-data-dir=$HOST_PROFILE
Icon=$INSTALL_DIR/public/icon-192.png
Terminal=false
Categories=AudioVideo;
DESKTOP
chown -R "$TARGET_USER":"$TARGET_USER" "$TARGET_HOME/.local"

# ───────────────────────────── Autologin (valfritt) ─────────────────────────────
if [[ "${AUTOLOGIN:-}" == "1" ]] || { [[ -z "${AUTOLOGIN:-}" && -t 0 ]] && read -rp "Aktivera automatisk inloggning för $TARGET_USER? [j/N] " a && [[ "$a" =~ ^[jJyY]$ ]]; }; then
  GDM_CONF=/etc/gdm3/custom.conf
  if [[ -f "$GDM_CONF" ]]; then
    log "Aktiverar GDM-autologin"
    sed -i '/^\s*#\?\s*AutomaticLoginEnable/d; /^\s*#\?\s*AutomaticLogin\s*=/d' "$GDM_CONF"
    sed -i "/^\[daemon\]/a AutomaticLoginEnable=true\nAutomaticLogin=$TARGET_USER" "$GDM_CONF"
  else
    echo "GDM hittades inte – konfigurera autologin manuellt för din display manager."
  fi
fi

# ───────────────────────────── Ström & brandvägg ─────────────────────────────
log "Inaktiverar viloläge (fläktlös kiosk ska alltid vara på)"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp comment 'LAN Karaoke'
fi

# ───────────────────────────── Start ─────────────────────────────
systemctl daemon-reload
systemctl enable --now yt-dlp-update.timer
systemctl enable lan-karaoke.service
systemctl restart lan-karaoke.service
sleep 2
systemctl --no-pager --lines=5 status lan-karaoke.service || true

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
echo
echo "✅ Klart!"
echo "   TV (kiosk):  http://localhost:$PORT/tv   (startar automatiskt vid inloggning)"
echo "   Mobil:       http://${LAN_IP:-<LAN-IP>}:$PORT/remote"
echo "   Loggar:      journalctl -u lan-karaoke -f"
echo "   Värdpanel:   http://localhost:$PORT/host  (appen \"Karaoke Värdpanel\" i programmenyn)"
echo "   Konfig:      $ENV_FILE"
echo "   Autostart:   AV som standard – slå på i värdpanelen (Kiosk & TV → Starta med datorn)"
echo "   Starta TV:   appen \"Karaoke TV\" i programmenyn · Stäng: pkill -f karaoke-kiosk"
echo "   HW-avkodning: kontrollera 'Video Decode: Hardware accelerated' på chrome://gpu"
