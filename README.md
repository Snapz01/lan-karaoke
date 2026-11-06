# 🎤 LAN Karaoke

**Karaoke för hela sällskapet: TV:n är scenen och mobilerna är fjärrkontrollen.**

Ett självhostat karaokesystem för hemmafesten. En liten dator kopplas till TV:n, och gästerna skannar en QR-kod, söker låtar, ställer sig i kön och peppar varandra med emojis. Allt är på svenska och fungerar i det lokala nätverket, utan konton och utan appar att installera.

> **OBS!** Systemet är byggt för en **MSI Cubi N 8GL** (Intel Celeron/Pentium, Intel UHD 600, 4–8 GB RAM) med **Ubuntu**, och är därför gjort för att vara resurssnålt: lätta animationer, ingen tung grafik och nedladdningar med låg prioritet. Det fungerar på annan hårdvara också, men har inte testats där.
>
> 💬 **Problem eller feedback?** Hör gärna av er via [GitHub Issues](https://github.com/SNAPZ01/lan-karaoke/issues). Alla förslag och felrapporter är välkomna!

![Låttext på TV:n](docs/tv-text.jpg)

---

## ✨ Funktioner

### 📺 På TV:n
- **Låttext som fylls i takt** med musiken, ord för ord, med nedräkning 3-2-1 inför varje vers
- **Intro-kort** som visar vem som sjunger härnäst
- **"🎤 Gör dig redo"-skylt** med nästa sångares namn i stor text de sista 20 sekunderna av låten före
- **Emoji-reaktioner** från publiken (🔥 👏 ❤️ 🎉 🍺 😂) och en **applådmätare** när låten är slut
- **Konfetti och fanfar** när en låt sjungits klart
- **Duetter**: rader märkta med `M:`/`F:` eller `Alla:` färgas per röst
- **Fyra teman**: Neon Party, Midnattsblå, Guld/Schlager (med discokula ✨) och Musikvideo i bakgrunden
- **Vänteläge** med QR-koder för Wi-Fi och appen, kön, senast sjungna och tips

| Vänteläge | Firande |
|---|---|
| ![Vänteläge](docs/tv-vantelage.jpg) | ![Firande](docs/tv-firande.jpg) |

### 📱 I mobilen (gäster)
- **Namnruta vid första besöket**: gästen skriver sitt namn en gång, det visas sedan uppe till höger och på TV:n när det är dags
- **Ett sökfält för allt**. Sökningen startar medan man skriver och visar tre sorters träffar (rubrikerna syns bara när det finns träffar):
  - ⚡ **Spela direkt**: låtar som redan finns på datorn
  - 🎤 **Sjung med artist**: originallåten med synkad text
  - 📺 **Karaoke-text**: karaokevideor utan sång
- **＋ direkt i kön** med ett tryck
- **🎲 Överraska mig**: helt slumpmässigt urval. En låt som visats för dig kommer inte igen på en timme, och låtar som redan sjungits ikväll eller ligger i kön hoppas över.
- **"Min tur"**: "Du är 3:e i kön – om ca 9 min", och telefonen vibrerar när det är din tur
- **Texten i mobilen** för den som sjunger vänd mot publiken
- **Artistens röst**: Full, Svag eller Av. Rösten tas bort med spektral analys (frekvens för frekvens), så bas, trummor och komp ligger kvar. Fungerar på stereolåtar; för monoinspelningar visas en varning och Karaoke-text-versionen rekommenderas.
- **Topplistor**: kvällens och alla tiders mest sjungna låtar och flitigaste sångare
- **Snabb text-synk** om texten kommer för tidigt eller för sent

| Sök | Topplista |
|---|---|
| ![Sök](docs/mobil-sok.jpg) | ![Topplista](docs/mobil-topplista.jpg) |

### 🎛️ Värdpanel (på datorn)
- Alla avancerade inställningar: tonartsändring, tempo, ljudnivå, EQ, rättvis kö och värdläge
- Låt- och textredigering med **tap-synk**
- Systemkontroll: disk, **ljudutgång** (HDMI, hörlursuttag/AUX, USB, Bluetooth – valet sparas och återställs vid start), testljud, YouTube-cookies, cache, omstart
- **Uppdatering från GitHub** med ett klick, med säkerhetskopia och möjlighet att ångra. Valfritt: **automatisk uppdatering** som bara installerar när det varit lugnt i 15 min (av som standard)

![Värdpanel](docs/vardpanel.jpg)

### 🎯 Synk mellan låt och text
Tre funktioner som kan slås på eller av var för sig i **värdpanelen → 🎯 Synk**:

| Funktion | Vad den gör | Standard |
|---|---|---|
| **Automatisk synk med röstanalys** | Analyserar sången i varje låt en gång och rättar skillnader i intro och tempo mellan YouTube-ljudet och texten. Ändrar bara när träffen är säker, annars visas ett förslag. Kan stängas av per låt i textredigeraren. | På |
| **Automatisk latenskompensation** | Räknar bort webbläsarens ljudbuffert och tonartsändringens fördröjning | På |
| **Ljudfördröjning TV/högtalare** | En gemensam justering för hela uppkopplingen. **🎯 Kalibrera på TV:n** visar en blixt och spelar ett klick, och du justerar tills de kommer samtidigt. | 0 ms |

> Tips: Kalibrera en gång när datorn, TV:n och högtalaren är på plats. Ljud som går via TV:n till en högtalare kommer ofta 50–200 ms efter bilden.

### 🧠 Funktioner i bakgrunden
- **Smart textsökning** för svenska och engelska låtar (hanterar å/ä/ö, "Remastered", "Live" med mera)
- **Jämn ljudnivå** mellan alla låtar (EBU R128)
- **Rättvis kö**: ingen får sin andra låt innan alla fått sin första
- **Kön överlever omstart**, och avbrutna nedladdningar fortsätter
- **Watchdog**: om TV-bilden fryser startas webbläsaren om automatiskt

---

## 🧰 Det här behövs

| Del | Rekommendation |
|---|---|
| Dator | Mini-PC med Intel Celeron/Pentium och 4–8 GB RAM (testad på MSI Cubi N 8GL) |
| System | Ubuntu 22.04, 24.04 eller 26.04 |
| Bild och ljud | HDMI till TV:n. Ljud antingen via TV:n eller direkt från datorns 3,5 mm-uttag till högtalarens AUX IN (rekommenderas: kortare fördröjning, ingen TV-ljudbehandling). |
| Mikrofoner | Kopplade direkt till högtalaren eller en mixer, så att sången inte får fördröjning |
| Nätverk | Wi-Fi som gästerna kan ansluta till, och internet för att hämta låtar |

---

## 🚀 Installation

```bash
git clone https://github.com/SNAPZ01/lan-karaoke.git
cd lan-karaoke
sudo bash setup-ubuntu.sh
```

Installern gör det här:
- Installerar Node.js, ffmpeg, yt-dlp och Chromium
- Frågar efter **PIN** (valfritt), **Wi-Fi** för QR-koden och **automatisk inloggning**
- Startar servern automatiskt när datorn startar, och lägger till apparna **Karaoke TV** och **Karaoke Värdpanel** i programmenyn

Starta om datorn när installern är klar.

### ▶️ Starta TV-vyn
**Automatisk start är avstängd som standard.** Datorn kan alltså användas som vanligt tills du vill sjunga.

| Vill du… | Gör så här |
|---|---|
| Starta karaoke nu | Öppna appen **Karaoke TV** i programmenyn |
| Starta automatiskt varje gång datorn slås på | **Karaoke Värdpanel** → Kiosk & TV → slå på **Starta karaoke-TV automatiskt när datorn startar** |
| Stänga TV-vyn | Tryck Alt+F4 eller kör `pkill -f karaoke-kiosk` |

> Servern körs alltid i bakgrunden, så värdpanelen och mobilerna fungerar även när TV-vyn är stängd.

TV:n visar väntelägets QR-kod, och festen kan börja. 🎉

---

## 🎶 Använda systemet

| Vem | Var | Adress |
|---|---|---|
| 📺 TV:n | Appen **Karaoke TV** (eller automatiskt, se ovan) | `http://localhost:3000/tv` |
| 📱 Gäster | Skanna QR-koden på TV:n | `http://<datorns-IP>:3000/remote` |
| 🎛️ Värd | Appen **Karaoke Värdpanel** på datorn | `http://localhost:3000/host` |

> Byt mellan TV-vyn och värdpanelen med **Alt+Tab**. Från en annan dator öppnas värdpanelen med `http://<IP>:3000/host` och din PIN.

---

## ⚙️ Inställningar

Inställningarna ligger i `/etc/default/lan-karaoke`. Starta om tjänsten efter en ändring:

```bash
sudo systemctl restart lan-karaoke
```

| Inställning | Betydelse |
|---|---|
| `KARAOKE_PIN` | PIN för värdpanelen från andra enheter (och värdläge) |
| `WIFI_SSID`, `WIFI_PASSWORD` | Wi-Fi-QR på TV:n |
| `WIFI_SHOW_PASSWORD` | `0` = visa bara QR-koden, inte lösenordet i text |
| `UPDATE_REPO` | GitHub-repo för uppdateringar, t.ex. `ditt-namn/lan-karaoke` |
| `UPDATE_TOKEN` | Bara om repot är privat |
| `CACHE_MAX_GB` | Max utrymme för karaoke-videor (standard 10) |
| `COVERS_ONLINE` | `0` = hämta inga albumomslag från internet |

---

## 🔄 Uppdatera

**Från värdpanelen:** 🔄 Uppdatering → *Sök efter uppdatering* → *Installera*.
Gick något fel? Tryck *Återställ föregående version*.

Låtar, kö, historik och inställningar påverkas aldrig av en uppdatering.

---

## 🩺 Felsökning

| Problem | Lösning |
|---|---|
| Inget ljud | Värdpanelen → Systemkontroll → **Ljudutgång**: välj rätt utgång och tryck **🔔 Testljud**. AUX-kabel: utgång → ingång (två ingångar mot varandra ger inget ljud). |
| Gästerna når inte sidan | Kontrollera att mobilen är på samma Wi-Fi som datorn |
| "YouTube kräver inloggning" | Ladda upp en `cookies.txt` i värdpanelen |
| Texten kommer fel | Använd **Snabb text-synk** och spara i värdpanelen |
| Videon hackar | Ställ datorns upplösning på 1920×1080 i stället för 4K |
| Något annat | `journalctl -u lan-karaoke -n 100 --no-pager` |

Hittar du inte lösningen? [Skapa ett ärende](https://github.com/SNAPZ01/lan-karaoke/issues/new) och bifoga utdata från kommandot ovan.

---

## 🏗️ För utvecklare

```bash
npm install
npm run dev     # http://localhost:3000/tv
npm test        # enhetstester (node:test)
```

Arkitektur, moduler och tekniska beslut beskrivs i **[docs/TEKNIK.md](docs/TEKNIK.md)**.

---

## 🤖 Byggd med Claude

Hela systemet är byggt i en konversation med **Claude Opus 5.5** från Anthropic. Hög resonemangsnivå användes för arkitektur och större funktioner, låg för små ändringar. Det gäller kod, design, tester, installer och den här README:n.

Vill du bygga ett eget? **[Här finns hela prompten och alla uppföljningar → docs/PROMPT.md](docs/PROMPT.md)**, med tips om hur du får bäst resultat.

---

## 📜 Licenser och tack

- Låttexter från [LRCLIB](https://lrclib.net), en öppen databas med synkade låttexter
- Nedladdning via [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- Typsnittet [Outfit](https://fonts.google.com/specimen/Outfit) under SIL Open Font License (se `public/fonts/Outfit-OFL.txt`)
- Albumomslag via iTunes Search API

> ⚠️ Systemet är tänkt för privat bruk hemma. Respektera upphovsrätten för musik och videor du laddar ner.
