# 🛠️ LAN Karaoke – teknisk dokumentation

Självhostad karaoke för Ubuntu-Mini-PC (MSI Cubi N 8GL, Intel UHD 600). En Node.js-server serverar TV-vyn (`/tv`, Chromium kiosk) och mobilfjärrkontrollen (`/remote`, svenska) över Wi-Fi.

## Struktur

```
lan-karaoke/
├── server.js              Express 5 + Socket.io: routes, kö/spelare, jobb, socket-händelser
├── lib/
│   ├── config.js          Miljövariabler och sökvägar
│   ├── util.js            UTF-8/NFC, filnamn, JSON-lagring (atomisk), rate limiter
│   ├── lrclib.js          LRCLIB-klient med dubbelsökning
│   ├── ytdlp.js           yt-dlp-wrapper, cookies, svenska felmeddelanden
│   ├── analysis.js        ffmpeg: loudness (EBU R128) + inledande tystnad → synkförslag
│   ├── covers.js          Albumomslag via iTunes Search API (strypt, cachat)
│   ├── system-audio.js    Ljudutgång/HDMI via pactl
│   ├── fair-queue.js      Rättvis kö (round-robin per sångare)
│   └── tags.js            Språk- och genretaggning
├── public/
│   ├── lrc.js             Delad parser: LRC, Enhanced LRC, duett-röster, VTT
│   ├── tv.html  tv.js  style.css  pitch-worklet.js  vocal-worklet.js
│   ├── remote.html  remote.js  remote.css  manifest.webmanifest
│   ├── fonts/             Outfit (SIL OFL 1.1, se Outfit-OFL.txt)
│   └── favicon.svg, icon-*.png, apple-touch-icon.png
├── test/                  node:test – kör utan npm-paket: npm test
├── setup-ubuntu.sh        Installer
├── media/  data/          (skapas) låtar, cache, omslag · library.json, settings.json, queue.json
```

## Installation (Ubuntu 22.04/24.04)

```bash
cd lan-karaoke
sudo bash setup-ubuntu.sh            # frågar om PIN och autologin
# eller: sudo KARAOKE_PIN=1234 AUTOLOGIN=1 bash setup-ubuntu.sh
```

| Åtgärd | Kommando |
|---|---|
| Loggar | `journalctl -u lan-karaoke -f` |
| Kiosk-loggar (watchdog) | `journalctl -t karaoke-kiosk` |
| Konfig | `/etc/default/lan-karaoke` → `sudo systemctl restart lan-karaoke` |
| Stäng kiosk | `touch ~/.config/karaoke-kiosk.disabled && pkill -f karaoke-kiosk` |
| Tester | `npm test` |
| Utveckling | `npm install && npm run dev` → `http://localhost:3000/tv` |

> Kopierat via Windows: kör `bash setup-ubuntu.sh` (körbarhetsbiten kan tappas). `.gitattributes` tvingar LF.

## Nytt i 2.0

### TV
- **Typsnittet Outfit** ligger lokalt (fungerar offline). Lyrics använder vikt 700, eftersom typsnittet bara finns i 400 och 700.
- **Reaktioner i sidofälten** (2–15 % och 85–96 % av bredden). De ligger under QR-kortet, så texten och koden går att läsa.
- **Initialer** i temafärg när omslag saknas. Riktiga omslag hämtas från iTunes för ”Sjung med artist”- och uppladdade låtar.
- **Teleprompter-rullning** vid radbyte och **återstående tid** i låtkortet.
- **Duetter**: rader som börjar med `M:`, `F:`, `D:`, `v1:`, `v2:` eller `Alla:` färgas per röst och får en etikett.
- **Vänteläge** visar antal låtar och minuter i kön, antal sångare, senast sjungna låtar, roterande tips och en dekorativ equalizer.
- **Temaeffekter**: Guld/Schlager har glitter och discokula, Midnattsblå har stjärnor, och Neon har en flimrande rubrik. Bara `transform` och `opacity` animeras.
- **Applådmätare** efter låten, med antal per emoji och ett omdöme ("Publikens favorit!").

### Mobil
- **Kompakt spelare** som fälls ut med ▾. Valet sparas i telefonen.
- **"Min tur"**: kortet visar "Du är 3:e i kön – om ca 9 min". Telefonen vibrerar när du är näst på tur och när det är din tur.
- **Omslag** i sökträffar, bibliotek och kö.
- **Hemskärmsapp**: manifest och ikoner finns (se begränsningar nedan).
- **Tomma vyer** med knappar för nästa steg.

### Funktion
| Funktion | Hur |
|---|---|
| **Kön sparas** | Den skrivs till `data/queue.json`. Vid omstart läggs pågående låt först och avbrutna nedladdningar startas om. |
| **Jämn ljudnivå** | ffmpeg `loudnorm` mäter varje låt en gång (nice 15, en åt gången) och TV:n förstärker eller dämpar mot −16 LUFS. Förstärkningen begränsas så att toppnivån inte går över 0 dBTP. Låtar från v1 analyseras i bakgrunden vid start. |
| **Synkförslag** | Om YouTube-ljudet är minst 1,5 s längre än LRCLIB-versionen och börjar tyst föreslås en offset. Den kan godkännas med ett tryck. |
| **HDMI** | Kiosken väljer HDMI-utgången vid inloggning (och igen efter 25 s). Systemkontroll visar alla utgångar och har knappen "Aktivera HDMI". |
| **YouTube-spärr** | Ladda upp en `cookies.txt` (Netscape-format) under Systemkontroll. yt-dlp-fel visas på svenska. |
| **Rättvis kö** | Ingen får sin andra låt innan alla fått sin första. Gränsen för antal låtar per sångare är 3 som standard. Dubbletter avvisas. |
| **Värdläge** | Kräver PIN. Gäster kan inte styra uppspelningen eller ändra inställningar. De kan rösta för att hoppa över (50 % av mobilerna, minst 2), ta bort sina egna låtar och hoppa över sin egen låt. |
| **Begränsningar** | Max 6 förfrågningar i rad, sedan 1 per minut och mobil. Max 3 samtidiga nedladdningar per mobil. Inga nedladdningar när mindre än 1 GB är ledigt på disken. |
| **Watchdog** | TV:n skickar ett hjärtslag var 5:e sekund. Om det saknas i 60 s, tre kontroller i rad, startas webbläsaren om. |


## Värdpanel (`/host`)

Gästerna (`/remote`) ser bara det enkla: sök, kö, reaktioner, textstorlek, text-synk, artistens röst och tema. Allt annat finns i **värdpanelen**:

- Öppna appen **Karaoke Värdpanel** i programmenyn på karaokedatorn, eller `http://localhost:3000/host`. Växla mot TV-vyn med Alt+Tab.
- Från en annan dator: `http://<IP>:3000/host` plus PIN. Det kräver att `KARAOKE_PIN` är satt.
- Innehåll: alla avancerade inställningar, låt- och textredigering, systemkontroll, ljudutgång, cookies och **uppdatering från GitHub**.
- Behörigheten kontrolleras på servern: karaokedatorn själv (localhost) är alltid värd. Andra enheter är gäster om de inte anger PIN. `TRUST_LOCALHOST=0` kräver PIN även lokalt.

### Uppdatering från GitHub
1. Lägg projektet i ett GitHub-repo, appen i roten eller i en undermapp.
2. Ange `UPDATE_REPO=ditt-namn/lan-karaoke` (och `UPDATE_TOKEN=` om repot är privat) i `/etc/default/lan-karaoke` och kör `sudo systemctl restart lan-karaoke`.
3. Värdpanelen → 🔄 Uppdatering → *Sök efter uppdatering* → *Installera*. Det här händer:
   1. Senaste commit laddas ner.
   2. `server.js` syntaxkontrolleras.
   3. Nuvarande version säkerhetskopieras till `data/backup`.
   4. Filerna skrivs över. `media/`, `data/` och `node_modules/` rörs inte.
   5. `npm install` körs om beroendena ändrats.
   6. Tjänsten startas om.
4. **Återställ föregående version** ångrar den senaste uppdateringen.

## Arkitekturbeslut

| Beslut | Varför |
|---|---|
| Ljudbehandlingen sker på TV:n | `AudioWorklet` kräver en säker anslutning. `localhost` räknas som det, men inte `http://<LAN-IP>` i mobilen. |
| YouTube laddas ner innan uppspelning | Länkarna till YouTube-strömmar är bundna till IP-adress, och ljud från en annan domän blir tyst i Web Audio. |
| JSON i stället för SQLite | Ingen kompilering av inbyggda moduler på Celeron. Atomisk skrivning räcker för tusentals låtar. |
| Textreserv från YouTube-undertexter | Ljudet tas från samma video som undertexterna, annars hamnar texten ur synk. |
| Ägarskap via HMAC-tagg | Mobilens klient-id skickas aldrig till andra mobiler. Statusen innehåller bara `owner`-taggen, så ingen kan ta bort andras låtar genom att utge sig för att vara dem. |
| Spektral sångdämpning (`vocal-worklet.js`) | Gamla L−R-metoden tog bort allt i mitten (bas, kick, virvel) och gav tystnad på monolåtar – upplevdes som volymsänkning. Nu: STFT 2048/hop 512, per frekvensband jämförs L och R; bara mittpanorerat innehåll i 120 Hz–8 kHz tas bort. Bas under 120 Hz orörd. Kostar uppskattningsvis 5–8 % av en kärna på Celeron och 43 ms latens (kompenseras i textsynken). Monolåtar detekteras och rapporteras till mobilen. |
| pactl med `LC_ALL=C` | Annars översätts fältnamnen (t.ex. "Namn:" på svenska) och tolkningen går sönder. |

## Kända begränsningar

- Kör TV:n i **1920×1080**, inte 4K.
- Hårdvaruavkodning av video beror på Chromium-versionen. Kontrollera `chrome://gpu`.
- **Hemskärmsapp över http**: Android visar inte "Installera app", eftersom det kräver https. "Lägg till på startskärmen" fungerar ändå, och på iOS öppnas sidan i helskärm.
- Tonartsändringen ger lätta artefakter vid ±5–6 halvtoner. Sångdämpningen tar bort det som ligger i mitten av stereobilden: sång försvinner, men även mittpanorerade solon kan dämpas, och eko/reverb på rösten kan ligga kvar svagt. Monoinspelningar kan inte separeras – välj Karaoke-text.
- iTunes-omslag kräver internet på Cubi-datorn. Stäng av med `COVERS_ONLINE=0`.
- `package-lock.json` saknas. Skapa den med `npm install` första gången och checka in den.
