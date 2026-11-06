# 🤖 Promptarna bakom LAN Karaoke

Hela projektet är byggt i en konversation med **Claude Opus 5.5** (Anthropic). Här finns startprompten och alla uppföljningar i ordning, så att du kan bygga ett eget system från grunden eller anpassa det efter dig.

> **Tips:** Börja med startprompten och lägg sedan till uppföljningarna en i taget. Testa mellan varje steg. Små, tydliga steg ger bättre resultat än en jätteprompt.

---

## 1. Startprompten

Klistra in den här som första meddelande. Byt gärna ut hårdvaran (MSI Cubi N 8GL) mot din egen.

```text
You are a Senior Fullstack Architect and UI/UX Designer. Build a complete, lightweight, self-hosted LAN Karaoke Web Application running on Ubuntu Linux, specifically optimized for a low-power fanless Mini-PC (MSI Cubi N 8GL with Intel Celeron/Pentium and Intel UHD 600 integrated graphics, 4-8GB RAM).

### 1. CORE CONCEPT, AESTHETICS & USER EXPERIENCE
The application consists of a single Node.js backend serving two distinct frontend views over the local Wi-Fi network:
1. **TV Screen View (`http://localhost:3000/tv`)**:
   - Runs in fullscreen Chromium Kiosk mode on the Ubuntu Mini-PC connected to a TV.
   - **Pro & Fun Lounge Aesthetic**: Deep neon/lounge glassmorphism theme (dark slate/purple gradients, glowing accents, album art background blur) that looks like a commercial karaoke system, while keeping GPU usage low (strictly CSS animations/canvas 2D, NO heavy WebGL).
   - **Fun Interactive Features**:
     - *"Up Next" Singer Banner*: Displays who is singing next with an animated intro card between songs.
     - *Live Emoji/Applause Reactions*: Guests can tap reaction buttons on their phones (🔥, 👏, ❤️, 🎉, 🍺) that float up smoothly on the TV screen in real time.
     - *End-of-Song Celebration*: Fun CSS confetti burst and fanfare overlay when a song finishes.
   - Persistent QR code card in the corner (pointing to `http://<LAN-IP>:3000/remote`), dynamic audio spectrum visualizer (lightweight 2D Canvas), and large karaoke lyrics with a smooth, sweeping color-fill highlight.
2. **Mobile Remote View (`http://<LAN-IP>:3000/remote`)**:
   - Opened by guests scanning the QR code with their smartphones.
   - **All UI text MUST be in Swedish**, polished, intuitive, and festive.

### 2. SWEDISH & ENGLISH SONG OPTIMIZATION (CRITICAL)
The majority of songs will be in **Swedish and English** (e.g., Gyllene Tider, ABBA, Veronica Maggio, Lasse Stefanz, Queen, etc.):
- **UTF-8 & Diacritics (`å, ä, ö`)**: Ensure strict UTF-8 encoding across Multer file uploads, filenames, SQLite/JSON storage, and LRCLIB API queries.
- **Smart Dual-Search Strategy**: When searching LRCLIB (`https://lrclib.net/api/search`), query the exact string first. If no synced lyrics are found for a Swedish title, automatically normalize/fallback by stripping special characters or searching `yt-dlp` with `"<query> karaoke"` or `"<query> lyrics"`.
- **Quick-Filter Tags in Search/Library**: Include quick category pills in the mobile UI: *"🇸🇪 Svenska Klassiker"*, *"🇬🇧 Engelska Hits"*, *"🕺 Dansband & Schlager"*, *"🎸 Rock & Pop"*.

### 3. SIMPLE VS. ADVANCED SETTINGS (MOBILE REMOTE UI)
Structure the settings and controls into two clear tiers so anyone at the party can use the basics, while power users can fine-tune the system:

#### A. Enkla Inställningar (Simple Controls - Always visible / 1-click access)
- **Volym & Ljud**: Master volume slider, Mute button, Play/Pause, Restart song, and Skip (`Hoppa över`).
- **Sångarens namn**: Optional quick input when queuing a song ("Vem sjunger?") so their name appears on the TV screen.
- **Textstorlek (TV)**: Quick toggle (`Normal` / `Stor` / `Extra Stor`) for easy reading from the couch.
- **Snabb Text-synk**: Simple `[Text kommer för tidigt -]` and `[Text kommer för sent +]` buttons (`±0.25s` steps) if a lyric is slightly off.
- **Bakgrundstema på TV**: Quick switch between *Neon Party*, *Midnattsblå*, *Guld/Schlager*, and *Musikvideo i bakgrunden*.

#### B. Avancerade Inställningar (Advanced Settings - Inside a collapsible/PIN-optional "⚙️ Avancerat" drawer)
- **Tonartsändring (Pitch Shift / Key Change)**: Real-time Web Audio API pitch shifting (`-6` to `+6` semitones) without changing tempo, or playback speed adjustment (`0.8x` to `1.2x`).
- **Exakt Text-offset (ms)**: Fine-grained slider/input in milliseconds (`-5000ms` to `+5000ms`) with a *"Spara synk permanent för denna låt"* button that writes the offset to the database.
- **Ljudutgång & Kanalval**: Stereo/Mono toggle and Vocal-Ducking/EQ filter (Web Audio API center-channel vocal reducer for standard MP3s that still have lead vocals).
- **Kiosk & TV-Kalibrering**: Toggle QR-code visibility, toggle emoji reactions on/off, adjust UI overscan padding (`0%` to `5%` for older TVs that cut off edges), and toggle auto-play next song vs. manual start.
- **Låt- & Textredigerare**: Ability to edit a song's Artist/Title metadata, re-fetch lyrics from LRCLIB, or paste/edit raw `.lrc` timestamps directly from the phone.
- **Systemkontroll**: View Mini-PC disk space, clear temporary YouTube cache, or trigger a clean service restart.

### 4. LYRIC SYNCHRONIZATION & HIGHLIGHTING ENGINE
1. Extract Artist, Title, and Duration (from ID3 tags, filename parsing `Artist - Title`, or search query).
2. Query the **LRCLIB API** (`https://lrclib.net/api/get` and fallback to `https://lrclib.net/api/search`) with a proper `User-Agent` header.
3. Parse `syncedLyrics` (`.lrc` format: `[mm:ss.xx] Lyric line`) and support Enhanced LRC word timestamps (`<mm:ss.xx>`).
4. **Smooth "Karaoke Sweep" Highlight**: Calculate the duration of the active line (`nextLine.time - currentLine.time`, capped for instrumental breaks). Run a `requestAnimationFrame` loop reading `audioElement.currentTime` + `lyricOffsetMs`. Render the active lyric line with a dual-layer CSS text fill (`background-clip: text` or overlay clip-path) that smoothly sweeps across the words in real time. Show a `3... 2... 1...` visual countdown bar before the first line and after long instrumental breaks (>8 seconds).

### 5. DUAL-MODE SONG INPUT (SEARCH + UPLOAD + LIBRARY)
- **Tab 1: "🔍 Sök Låt"**:
  - *"Med Auto-text (LRCLIB + Audio)"*: Searches LRCLIB for confirmed synced lyrics, fetches matching audio via `yt-dlp -f bestaudio` into `/media`, and pairs them.
  - *"Karaoke-video (YouTube)"*: Searches `yt-dlp "ytsearch8:<query> karaoke"` and downloads/streams the MP4 (max 720p/1080p H.264 for hardware decoding on Intel UHD 600) directly to the TV `<video>` player.
- **Tab 2: "📁 Ladda upp låt"**: Upload `.mp3`, `.wav`, `.flac`, or `.mp4` (plus optional `.lrc`). Auto-matches lyrics via LRCLIB using ID3 tags or filename, saves to `/media`, and queues.
- **Tab 3: "📚 Bibliotek"**: Instant 1-click access to all locally saved songs with search and Swedish/English tags.

### 6. DELIVERABLES REQUIRED
Provide the complete, production-ready implementation with NO placeholders or truncated logic:
1. Project directory structure and `package.json`.
2. `server.js` (Express, Socket.io, UTF-8 Multer upload, `music-metadata`, LRCLIB integration, `yt-dlp` wrapper, persistent JSON/SQLite library with per-song saved offsets, and automatic LAN IP detection).
3. `public/tv.html`, `public/tv.js`, `public/style.css` (The lounge-themed TV screen player with 60fps sweeping lyric highlighter, 2D canvas audio visualizer, floating emoji reactions, "Up Next" singer overlay, confetti celebration, and QR code).
4. `public/remote.html`, `public/remote.js` (Swedish mobile interface with Search, Upload, Library, Queue, Reaction bar, Simple Controls, and the collapsible Advanced Settings menu including Web Audio API pitch/vocal reducer).
5. `setup-ubuntu.sh`: Ubuntu bash installer (`nodejs`, `ffmpeg`, `yt-dlp`, `chromium-browser`), `systemd` service for auto-boot, and desktop autostart (`--kiosk --autoplay-policy=no-user-gesture-required http://localhost:3000/tv`).```

---

## 2. Uppföljningar (i den ordning de gjordes)

Varje rad är ett eget meddelande till Claude efter startprompten.

| # | Prompt | Resultat |
|---|---|---|
| 1 | `fortsätt` | Granskning av koden mot riktiga API:er och sju buggfixar |
| 2 | `ge exempel hur du kan förbättra på den visuellt. ge exempel på andra delar som behöver förbättras på.` | Förslagslista: visuellt, mobil och funktion |
| 3 | `jag vill ha alla kör på` | Version 2.0: typsnitt, temaeffekter, duetter, applådmätare, "Min tur", ljudnormalisering, rättvis kö, värdläge, HDMI, watchdog, sparad kö, moduler och tester |
| 4 | `kan du ändra texterna till "Sjung med artist" och "Karaoke-text"` + beskrivning av ljuduppkopplingen | Tydligare namn och fler idéer anpassade till uppkopplingen |
| 5 | `kör på hög prio` + Wi-Fi-namn | Artistens röst (Full/Svag/Av), texten i mobilen, Wi-Fi-QR på TV:n |
| 6 | `förbättra på sök låt sidan så den blir mer användarvänlig och lättare.` | Ett sökfält, sökning medan man skriver, ＋ direkt i kön, senaste sökningar |
| 7 | `jag vill ha historik där man kan sortera … dagens mest uppspelade och alla tiders mest uppspelade` | Topplistor och historik i Biblioteket |
| 8 | `slumpa låt knapp` | 🎲 Överraska mig |
| 9 | `när man klickar på slumpa per telefon så kan den inte ge samma som man valde bort under 1 timmes tid` | Bortvalda låtar per mobil i en timme |
| 10 | `har du några helt andra förbättringsidéer?` | Idéer: spellägen, socialt, hårdvara, drift |
| 11 | `jag gillar värdpanel på datorn … hämta ny version från github där istället för på mobil så inte gäster råkar pilla på inställningar` | Värdpanelen `/host`, behörighet på servern, uppdatering från GitHub med möjlighet att ångra |
| 12 | `hjälp mig med github gör en readme på svenska` | Den här README:n och skärmdumparna |

---

## 3. Tips för att bygga med Claude

**Prompten**
- **Beskriv hårdvaran och begränsningarna.** "Celeron + UHD 600, ingen tung WebGL" fick Claude att välja lätta lösningar, till exempel att animera bara `transform`/`opacity` och att undvika `backdrop-filter` över video.
- **Skriv vilka som använder systemet.** "Gästerna ska bara se det enkla" gav en bättre uppdelning än en lista med knappar.
- **Be om leverabler, inte bara idéer:** "Ge hela filerna, inga platshållare."
- **Skriv på det språk som användarna har.** Då blir texterna i gränssnittet naturliga direkt.

**Arbetsflödet**
- **Be Claude ifrågasätta specen.** Flera förslag i startprompten gick inte att genomföra som de var formulerade. Ljudbehandlingen i mobilen kräver till exempel en säker anslutning, och YouTube-videor kan inte strömmas direkt till en ljudgraf. Claude föreslog bättre vägar.
- **Fråga "vad kan förbättras?"** efter varje version. Det gav de bästa idéerna.
- **Låt Claude testa.** Be om automatiska tester och skärmdumpar. Flera buggar hittades så, till exempel en radbrytning och emojis som täckte QR-koden.
- **En sak i taget** när det gäller ändringar i gränssnittet. Det är lättare att se vad som blev bättre.

**Resonemangsnivå (hög/låg)**
- **Hög:** arkitektur, nya funktioner som berör flera filer, felsökning och säkerhet (behörighet, uppdateringar).
- **Låg:** textändringar, små gränssnittsjusteringar, enkla frågor ("Finns Claude på Linux?").
- Rätt nivå sparar tid. Låg nivå räcker ofta för små ändringar, medan hög ger färre buggar i större ändringar.

**Säkerheten**
- **Skicka inte lösenord i chatten** om det går att undvika. Lägg dem i en konfigurationsfil, som `/etc/default/lan-karaoke` här.
- Be Claude kontrollera att inga hemligheter hamnar i repot innan du gör det publikt.
