'use strict';
// LAN Karaoke – mobilfjärrkontroll (svenska). Ingen innerHTML med användardata: allt byggs med h().
(() => {
  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c.nodeType ? c : String(c));
    }
    return el;
  }

  const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtTs = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
  const fmtBytes = (b) => { if (!b && b !== 0) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return `${b.toFixed(i > 1 ? 1 : 0).replace('.', ',')} ${u[i]}`; };
  const fmtSec = (ms) => `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${Math.abs(ms / 1000).toFixed(2).replace('.', ',')} s`;
  const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const vibrate = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* ignoreras */ } };
  const TAG_ICON = { sv: '🇸🇪', en: '🇬🇧', dansband: '🕺', rockpop: '🎸' };
  const TAG_NAME = { sv: '🇸🇪 Svenska', en: '🇬🇧 Engelska', dansband: '🕺 Dansband & Schlager', rockpop: '🎸 Rock & Pop' };
  const SINGER_KEY = 'karaoke.singer';
  // /host = samma app i värdläge: desktop-layout, alla inställningar, system och uppdatering. Gäster (/remote) ser bara det enkla.
  const HOST = location.pathname.startsWith('/host');
  if (HOST) {
    document.body.classList.add('host');
    document.title = '🎛️ Karaoke – Värdpanel';
    document.querySelector('main').before(document.querySelector('nav.tabs')); // flikar överst på desktop
  }
  const CID_KEY = 'karaoke.cid';
  let clientId = localStorage.getItem(CID_KEY);
  if (!/^[\w-]{8,64}$/.test(clientId || '')) {
    clientId = `c${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    localStorage.setItem(CID_KEY, clientId);
  }
  let myOwner = null;
  const enc = encodeURIComponent;
  const ordinal = (n) => `${n}:${[1, 2].includes(n % 10) && ![11, 12].includes(n % 100) ? 'a' : 'e'}`;
  const initials = (t) => { const w = (t || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase(); };
  const hueOf = (t) => { let x = 0; for (const c of t || '') x = (x * 31 + c.codePointAt(0)) % 360; return x; };
  // Omslag med initial-reserv. lookup=true → iTunes via servern (/api/cover), 404 → initialerna syns.
  function coverEl(url, artist, title, { lookup = false } = {}) {
    const ph = h('div', { class: 'cover-ph', style: `--h:${hueOf(artist || title)}` }, initials(artist || title));
    const wrap = h('div', { class: 'cov' }, ph);
    const src = url || (lookup && title ? `/api/cover?artist=${enc(artist || '')}&title=${enc(title)}` : null);
    if (src) {
      const img = h('img', { alt: '', loading: 'lazy' });
      img.addEventListener('error', () => img.remove());
      img.src = src;
      wrap.appendChild(img);
    }
    return wrap;
  }
  const isGuest = () => !!(S.settings.hostMode && !admin);
  const isMine = (e) => {
    if (!e) return false;
    if (myOwner && e.owner) return e.owner === myOwner;
    const name = (localStorage.getItem(SINGER_KEY) || '').trim().toLowerCase();
    return !!name && (e.singer || '').trim().toLowerCase() === name;
  };
  const ackToast = (r) => { if (r?.error) toast(r.error, 'error'); };

  const SUGGEST = {
    sv: ['Gyllene Tider - Sommartider', 'Ted Gärdestad - Sol, vind och vatten', 'Lisa Nilsson - Himlen runt hörnet', 'Veronica Maggio - Jag kommer',
      'Håkan Hellström - Känn ingen sorg för mig Göteborg', 'Tomas Ledin - Sommaren är kort', 'Eva Dahlgren - Vem tänder stjärnorna',
      'Ulf Lundell - Öppna landskap', 'Björn Skifs - Michelangelo', 'Lars Winnerbäck - Hum hum från Humlegården'],
    en: ['ABBA - Dancing Queen', 'Queen - Bohemian Rhapsody', "Bon Jovi - Livin' on a Prayer", 'Whitney Houston - I Wanna Dance with Somebody',
      'Toto - Africa', "Journey - Don't Stop Believin'", 'Robbie Williams - Angels', 'Spice Girls - Wannabe', 'Roxette - The Look', 'Europe - The Final Countdown'],
    dansband: ['Lasse Stefanz - De sista ljuva åren', "Vikingarna - Kan man älska nå'n på avstånd", 'Thorleifs - Gråt inga tårar',
      'Lotta Engberg - Fyra Bugg och en Coca Cola', 'Arvingarna - Eloise', 'Kikki Danielsson - Papaya Coconut', 'Herreys - Diggi-Loo Diggi-Ley',
      'Carola - Fångad av en stormvind', 'Black Jack - Inget stoppar oss nu'],
    rockpop: ["Queen - Don't Stop Me Now", "Bon Jovi - It's My Life", 'Roxette - It Must Have Been Love', 'The Killers - Mr. Brightside', 'Oasis - Wonderwall',
      'Kent - Dom andra', 'Mando Diao - Dance with Somebody', 'Avicii - Wake Me Up', 'The Ark - It Takes a Fool to Remain Sane'],
  };

  // ───────────────────────────── Tillstånd ─────────────────────────────
  const socket = window.io({ transports: ['websocket', 'polling'] });
  let S = { queue: [], now: null, phase: 'idle', settings: {}, jobs: [], liveOffsetMs: 0, pinRequired: false, tvConnected: false };
  let pin = sessionStorage.getItem('karaoke.pin') || '';
  let admin = false;
  let playback = { t: 0, d: 0, paused: true, at: Date.now() };
  let library = [];
  let libraryLoaded = false;
  let libTag = '';
  let searchMode = 'lyrics';
  let searchToken = 0;

  async function api(url, { method = 'GET', body } = {}) {
    const opts = { method, headers: {} };
    if (pin) opts.headers['x-karaoke-pin'] = pin;
    opts.headers['x-client-id'] = clientId;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json; charset=utf-8'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* tomt svar */ }
    if (res.status === 401) { admin = false; throw new Error('PIN krävs för den här funktionen'); }
    if (!res.ok) throw new Error(data?.error || `Fel ${res.status}`);
    return data;
  }

  function toast(msg, type = '') {
    const el = h('div', { class: `toast ${type}` }, msg);
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
  }

  const throttle = (fn, ms) => {
    let last = 0; let timer = null; let lastArgs;
    return (...args) => {
      lastArgs = args;
      const wait = ms - (Date.now() - last);
      if (wait <= 0) { last = Date.now(); fn(...args); }
      else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs); }, wait);
    };
  };

  function armConfirm(btn, fn) {
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
    btn.dataset.label = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = '⚠️ Tryck igen för att bekräfta';
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 3500);
  }

  // ───────────────────────────── Sheet ─────────────────────────────
  function openSheet(...nodes) {
    $('sheetBody').replaceChildren(...nodes.filter(Boolean));
    $('sheet').classList.remove('hidden');
    $('sheet').setAttribute('aria-hidden', 'false');
  }
  function closeSheet() {
    $('sheet').classList.add('hidden');
    $('sheet').setAttribute('aria-hidden', 'true');
    $('sheetBody').replaceChildren();
  }
  qsa('[data-close]').forEach((el) => el.addEventListener('click', closeSheet));

  function requestPin(onOk) {
    const input = h('input', { type: 'password', inputmode: 'numeric', placeholder: 'PIN-kod', autocomplete: 'off' });
    const go = () => {
      const val = input.value.trim();
      socket.emit('auth', { pin: val }, (r) => {
        if (r?.ok) {
          pin = val; admin = true; sessionStorage.setItem('karaoke.pin', val);
          closeSheet(); renderLock(); toast('🔓 Avancerat upplåst', 'ok'); onOk?.();
        } else { toast('Fel PIN-kod', 'error'); input.value = ''; }
      });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    openSheet(h('h2', {}, '🔒 Ange PIN'), h('div', { class: 'sub' }, 'Avancerade inställningar är skyddade med PIN-kod.'),
      h('div', { class: 'stack' }, input, h('button', { class: 'primary wide', onclick: go }, 'Lås upp')));
    setTimeout(() => input.focus(), 250);
  }
  const ensureAdmin = (fn) => (admin ? fn() : S.pinRequired ? requestPin(fn) : toast('Det här görs i värdpanelen på karaokedatorn', 'error'));

  // ───────────────────────────── Flikar ─────────────────────────────
  function showView(name) {
    qsa('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    qsa('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
    if (name === 'library' && !libraryLoaded) loadLibrary();
    if (name === 'settings' && $('adv').open) loadSystem();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  qsa('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ───────────────────────────── Nu spelas ─────────────────────────────
  function isPlaying() { return !!S.now && !playback.paused && S.phase !== 'intro'; }

  function renderNow() {
    const n = S.now;
    if (n) {
      $('nowTitle').textContent = n.title;
      $('nowSub').textContent = `${n.artist}${n.singer ? ` · 🎤 ${n.singer}` : ''}${S.phase === 'intro' ? ' · startar…' : ''}`;
      setNowCover(n.cover, n.artist, n.title);
    } else {
      $('nowTitle').textContent = S.phase === 'celebrate' ? '🎉 Applåder!' : 'Inget spelas';
      const ready = S.queue.some((e) => e.ready);
      $('nowSub').textContent = S.phase === 'waiting' && ready ? 'Tryck ▶ för att starta nästa låt' : S.queue.length ? 'Väntar på nedladdning…' : 'Välj en låt nedan 🎶';
      setNowCover(null, '', '');
    }
    setToggleIcons();
    const guest = isGuest();
    const own = isMine(S.now);
    qsa('#nowMore .controls, #nowMore .volume, #btnToggleMini').forEach((el) => el.classList.toggle('hidden', guest));
    const vote = $('btnVote');
    const showVote = guest && !!S.now && !own;
    vote.classList.toggle('hidden', !(showVote || (guest && own)));
    if (guest && own) { vote.textContent = '⏭ Hoppa över min låt'; vote.classList.remove('voted'); }
    else if (showVote) {
      const voted = votedQid === S.now.qid;
      vote.classList.toggle('voted', voted);
      vote.textContent = `🗳️ ${voted ? 'Du har röstat' : 'Rösta för att hoppa över'} (${S.votes?.count || 0}/${S.votes?.needed || 2})`;
    }
    $('btnLyrics').classList.toggle('hidden', !(S.now && S.now.hasLyrics));
    renderProgress();
    renderMyTurn();
    if (lv.open) syncLyricsView();
  }

  // ───────────────────────────── Text i mobilen ─────────────────────────────
  // Sångaren står ofta vänd mot publiken. Tiden interpoleras från TV:ns rapporter (1/s) + aktuell offset.
  const lv = { open: false, songId: null, lines: [], idx: -2, raf: 0, parse: null, spans: [] };
  async function syncLyricsView() {
    if (!S.now || !S.now.hasLyrics) { closeLyricsView(); return; }
    if (lv.songId === S.now.id) return;
    lv.songId = S.now.id;
    lv.lines = [];
    lv.idx = -2;
    $('lvTitle').textContent = `${S.now.title} – ${S.now.artist}`;
    try {
      if (!lv.parse) lv.parse = (await import('/lrc.js')).parseLrc;
      const song = await api(`/api/songs/${encodeURIComponent(S.now.id)}`);
      lv.lines = lv.parse(song.lrc || '').lines;
    } catch (e) { toast(e.message, 'error'); }
  }
  function openLyricsView() {
    lv.open = true;
    lv.songId = null;
    document.body.classList.add('lv-open');
    $('lyricsView').classList.remove('hidden');
    syncLyricsView();
    cancelAnimationFrame(lv.raf);
    const loop = () => { lv.raf = requestAnimationFrame(loop); drawLyricsView(); };
    loop();
  }
  function closeLyricsView() {
    lv.open = false;
    cancelAnimationFrame(lv.raf);
    document.body.classList.remove('lv-open');
    $('lyricsView').classList.add('hidden');
  }
  function drawLyricsView() {
    const L = lv.lines;
    if (!L.length) return;
    const t = lyricTimeNow();
    let i = -1;
    for (let k = 0; k < L.length; k++) { if (L[k].t <= t) i = k; else break; }
    const textAt = (from, dir) => { for (let k = from; k >= 0 && k < L.length; k += dir) if (L[k].text) return k; return -1; };
    if (i !== lv.idx) {
      lv.idx = i;
      const cur = i >= 0 && L[i].text ? i : -1;
      const n1 = textAt(i + 1, 1);
      const n2 = n1 >= 0 ? textAt(n1 + 1, 1) : -1;
      const p = textAt(cur >= 0 ? i - 1 : i, -1);
      $('lvPrev').textContent = p >= 0 ? L[p].text : '';
      $('lvNext').textContent = n1 >= 0 ? L[n1].text : '';
      $('lvNext2').textContent = n2 >= 0 ? L[n2].text : '';
      const curEl = $('lvCur');
      curEl.replaceChildren();
      lv.spans = [];
      if (cur >= 0) {
        for (const ch of Array.from(L[cur].text)) { const sp = document.createElement('span'); sp.textContent = ch; curEl.appendChild(sp); lv.spans.push(sp); }
      } else curEl.textContent = n1 >= 0 ? '♪ ♪ ♪' : '';
    }
    // Fyll tecken för tecken över radens längd (max 8 s vid långa pauser)
    if (i >= 0 && L[i].text && lv.spans.length) {
      const next = i + 1 < L.length ? L[i + 1].t : L[i].t + 5;
      const dur = Math.min(next - L[i].t, 8) * 0.94;
      const n = Math.floor(Math.min(1, (t - L[i].t) / dur) * lv.spans.length);
      lv.spans.forEach((sp, k) => { const on = k < n; if (sp.classList.contains('done') !== on) sp.classList.toggle('done', on); });
    }
    const d = playback.d || S.now?.duration || 0;
    const r = Math.max(0, Math.ceil(d - estimatePlaybackTime()));
    $('lvTime').textContent = `−${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
  }
  $('btnLyrics').addEventListener('click', () => { vibrate(); openLyricsView(); });
  $('lvClose').addEventListener('click', closeLyricsView);

  let votedQid = null;
  $('btnVote').addEventListener('click', () => {
    if (!S.now) return;
    vibrate();
    if (isMine(S.now)) { socket.emit('player:cmd', { cmd: 'skip' }, ackToast); return; }
    if (votedQid === S.now.qid) return;
    votedQid = S.now.qid;
    socket.emit('player:voteSkip', {}, (r) => { if (r?.error) toast(r.error, 'error'); });
    renderNow();
  });

  function setToggleIcons() {
    const icon = isPlaying() ? '⏸' : '▶';
    $('btnToggle').textContent = icon;
    $('btnToggleMini').textContent = icon;
  }

  let nowCoverKey = '';
  function setNowCover(url, artist, title) {
    const key = `${url}|${artist}|${title}`;
    if (key === nowCoverKey) return;
    nowCoverKey = key;
    const ph = $('nowPh');
    ph.textContent = title ? initials(artist || title) : '🎤';
    ph.style.setProperty('--h', hueOf(artist || title));
    const img = $('nowCover');
    img.style.visibility = 'hidden';
    if (url) { img.onload = () => { img.style.visibility = 'visible'; }; img.src = url; } else img.removeAttribute('src');
  }

  const NOW_OPEN_KEY = 'karaoke.nowOpen';
  $('nowBar').classList.toggle('open', localStorage.getItem(NOW_OPEN_KEY) === '1');
  const toggleNow = () => {
    const open = !$('nowBar').classList.contains('open');
    $('nowBar').classList.toggle('open', open);
    localStorage.setItem(NOW_OPEN_KEY, open ? '1' : '0');
  };
  $('btnExpand').addEventListener('click', toggleNow);
  $('nowInfo').addEventListener('click', toggleNow);

  // ───────────────────────────── Min tur ─────────────────────────────
  const notified = new Set();
  function notifyOnce(key, msg) {
    if (notified.has(key)) return;
    notified.add(key);
    vibrate([220, 120, 220]);
    toast(msg, 'ok');
  }
  function renderMyTurn() {
    const el = $('myTurn');
    const intro = S.introSeconds || 0;
    if (S.now && isMine(S.now)) {
      el.className = 'myturn now';
      el.replaceChildren(h('b', {}, '🎤'), h('div', {}, 'Det är din tur nu!', h('small', {}, `${S.now.title} – sjung ut! 🎶`)));
      notifyOnce(`now:${S.now.qid}`, '🎤 Det är din tur – gå fram till mikrofonen!');
      return;
    }
    const q = S.queue || [];
    const idx = q.findIndex(isMine);
    if (idx < 0) { el.className = 'myturn hidden'; return; }
    let sec = S.now ? Math.max(0, (playback.d || S.now.duration || 0) - (playback.t || 0)) : 0;
    for (let i = 0; i < idx; i++) sec += (q[i].duration || 210) + intro;
    sec += intro;
    const mins = Math.max(1, Math.round(sec / 60));
    const e = q[idx];
    if (idx === 0) {
      el.className = 'myturn next';
      el.replaceChildren(h('b', {}, '⏭️'), h('div', {}, 'Du är näst på tur!', h('small', {}, `${e.title} · ${S.now ? `om ca ${mins} min` : 'snart'}${e.ready ? '' : ' · laddas ner…'}`)));
      if (S.now) notifyOnce(`next:${e.qid}`, '⏭️ Du är näst på tur – gör dig redo!');
    } else {
      el.className = 'myturn';
      el.replaceChildren(h('b', {}, '🎟️'), h('div', {}, `Du är ${ordinal(idx + 1)} i kön`, h('small', {}, `${e.title} · om ca ${mins} min`)));
    }
  }

  function renderProgress() {
    const pct = S.now && playback.d > 0 ? Math.min(100, (playback.t / playback.d) * 100) : 0;
    $('nowProgress').style.width = `${pct}%`;
  }

  qsa('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
    vibrate();
    socket.emit('player:cmd', { cmd: b.dataset.cmd }, ackToast);
  }));

  const sendVolume = throttle((v) => socket.emit('settings:set', { volume: v }), 80);
  $('volume').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    S.settings.volume = v;
    $('volLabel').textContent = `${Math.round(v * 100)}%`;
    sendVolume(v);
  });
  $('btnMute').addEventListener('click', () => { vibrate(); setSetting('muted', !S.settings.muted); });

  // ───────────────────────────── Inställningar ─────────────────────────────
  function setSetting(key, value) {
    S.settings[key] = value;
    renderSettings();
    socket.emit('settings:set', { [key]: value }, (r) => {
      if (r?.error) { toast(r.error, 'error'); if (/PIN/.test(r.error)) { admin = false; requestPin(() => setSetting(key, value)); } }
    });
  }
  const parseV = (v) => (v === 'true' ? true : v === 'false' ? false : (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v));

  qsa('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    if (el.classList.contains('seg') || el.classList.contains('themes')) {
      qsa('button', el).forEach((b) => b.addEventListener('click', () => { vibrate(); setSetting(key, parseV(b.dataset.v)); }));
    } else if (el.type === 'range') {
      const send = throttle((v) => socket.emit('settings:set', { [key]: v }, (r) => r?.error && toast(r.error, 'error')), 120);
      el.addEventListener('input', () => { const v = Number(el.value); S.settings[key] = v; renderLabels(); send(v); });
    } else if (el.type === 'checkbox') {
      el.addEventListener('change', () => setSetting(key, el.checked));
    }
  });

  // Samma tidsmodell som TV:n: autosynk (tempo/förskjutning) + manuell justering − ljudfördröjning
  function lyricTimeNow() {
    let t = estimatePlaybackTime();
    const sy = S.now?.sync;
    if (S.settings.autoSync !== false && sy?.applied) t = (t - sy.shiftSec) / sy.scale;
    t += (S.liveOffsetMs || 0) / 1000;
    t -= (S.settings.avLatencyMs || 0) / 1000;
    t -= playback.lat || 0;
    return t;
  }

  $('btnCalibStart').addEventListener('click', () => socket.emit('calib:set', { on: true }, (r) => (r?.error ? toast(r.error, 'error') : toast('🎯 Titta på TV:n och lyssna – justera reglaget tills blixt och klick sammanfaller', 'ok'))));
  $('btnCalibStop').addEventListener('click', () => socket.emit('calib:set', { on: false }, ackToast));

  function renderLabels() {
    $('avLatLabel').textContent = `${S.settings.avLatencyMs || 0} ms`;
    const s = S.settings;
    const p = s.pitch || 0;
    $('pitchLabel').textContent = `${p > 0 ? '+' : ''}${p} halvton${Math.abs(p) === 1 ? '' : 'er'}`;
    $('speedLabel').textContent = `${(s.speed || 1).toFixed(2).replace('.', ',')}×`;
    $('vocalLabel').textContent = `${Math.round((s.vocalReduce || 0) * 100)}%`;
    $('overscanLabel').textContent = `${String(s.overscan || 0).replace('.', ',')}%`;
    $('introLabel').textContent = s.introSeconds ? `${s.introSeconds} s` : 'Av';
    $('monoHint').classList.toggle('hidden', !(S.vocalMono && (s.vocalReduce || 0) > 0));
    $('maxPerLabel').textContent = s.maxPerSinger ? String(s.maxPerSinger) : 'Obegränsat';
    $('voteLabel').textContent = `${s.voteSkipPercent || 50}% av mobilerna`;
    $('hostWarn').classList.toggle('hidden', !(s.hostMode && !S.pinRequired));
    qsa('[data-label]').forEach((el) => { const v = s[el.dataset.label] || 0; el.textContent = `${v > 0 ? '+' : ''}${v} dB`; });
    $('volLabel').textContent = `${Math.round((s.volume ?? 0.85) * 100)}%`;
  }

  function renderSettings() {
    const s = S.settings;
    qsa('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      if (el.classList.contains('seg') || el.classList.contains('themes')) {
        qsa('button', el).forEach((b) => b.classList.toggle('on', String(s[key]) === b.dataset.v));
      } else if (el.type === 'range') {
        if (document.activeElement !== el && s[key] !== undefined) el.value = s[key];
      } else if (el.type === 'checkbox') el.checked = !!s[key];
    });
    if (document.activeElement !== $('volume')) $('volume').value = Math.round((s.volume ?? 0.85) * 100);
    $('btnMute').textContent = s.muted ? '🔇' : '🔊';
    $('reactBar').classList.toggle('off', s.reactionsEnabled === false);
    renderLabels();
  }

  function renderOffset() {
    const ms = S.liveOffsetMs || 0;
    const sug = S.now?.suggestedOffsetMs || 0;
    const sb = $('btnSuggestion');
    sb.classList.toggle('hidden', !sug || sug === ms);
    if (sug) sb.textContent = `💡 YouTube-versionen har längre intro – flytta texten ${fmtSec(sug)}`;
    $('offsetLabel').textContent = fmtSec(ms);
    if (document.activeElement !== $('offsetRange')) $('offsetRange').value = ms;
    if (document.activeElement !== $('offsetNum')) $('offsetNum').value = ms;
  }

  $('btnEarly').addEventListener('click', () => { vibrate(); socket.emit('offset:nudge', { deltaMs: -250 }); });
  $('btnLate').addEventListener('click', () => { vibrate(); socket.emit('offset:nudge', { deltaMs: 250 }); });
  const sendOffset = throttle((ms) => socket.emit('offset:set', { ms }, (r) => r?.error && toast(r.error, 'error')), 120);
  $('offsetRange').addEventListener('input', (e) => { $('offsetNum').value = e.target.value; sendOffset(Number(e.target.value)); });
  $('offsetNum').addEventListener('change', (e) => { const v = Math.max(-5000, Math.min(5000, Number(e.target.value) || 0)); $('offsetRange').value = v; sendOffset(v); });
  $('btnSaveOffset').addEventListener('click', () => {
    socket.emit('offset:save', {}, (r) => (r?.ok ? toast(`💾 Synk sparad (${fmtSec(r.offsetMs)})`, 'ok') : toast(r?.error || 'Kunde inte spara', 'error')));
  });
  $('btnSuggestion').addEventListener('click', () => {
    socket.emit('offset:applySuggestion', {}, (r) => (r?.error ? toast(r.error, 'error') : toast(r.saved ? '💡 Synkförslaget sparat för låten' : '💡 Synkförslaget används (spara under ⚙️ Avancerat)', 'ok')));
  });
  $('btnResetKey').addEventListener('click', () => {
    socket.emit('settings:set', { pitch: 0, speed: 1 }, (r) => (r?.error ? toast(r.error, 'error') : toast('Tonart och tempo återställda', 'ok')));
  });

  function renderLock() { $('lockIcon').textContent = S.pinRequired ? (admin ? '🔓' : '🔒') : ''; }
  $('adv').addEventListener('toggle', () => {
    if (!$('adv').open) return;
    if (!admin) { $('adv').open = false; ensureAdmin(() => { $('adv').open = true; }); return; }
    loadSystem();
    if (HOST) loadUpdate();
  });

  // ───────────────────────────── Reaktioner ─────────────────────────────
  qsa('#reactBar button').forEach((b) => b.addEventListener('click', () => {
    vibrate(10);
    socket.emit('reaction', { emoji: b.dataset.e });
    b.classList.add('pop');
    setTimeout(() => b.classList.remove('pop'), 140);
  }));

  // ───────────────────────────── Sök ─────────────────────────────
  // Ett sökfält för allt: biblioteket filtreras direkt medan man skriver, LRCLIB efter en kort paus,
  // och karaoke-videor laddas i en egen sektion så att den långsamma YouTube-sökningen inte blockerar.
  const RECENT_KEY = 'karaoke.recent';
  const getRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
  function pushRecent(q) {
    const list = [q, ...getRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }
  function renderSearchHome() {
    const rec = getRecent();
    $('recentTitle').classList.toggle('hidden', !rec.length);
    $('recentChips').replaceChildren(...rec.map((r) => h('button', { onclick: () => { $('q').value = r; onQueryChange(true); } }, `🕘 ${r}`)));
  }

  let searchTimer = null;
  let lastQuery = '';
  function onQueryChange(immediate = false) {
    const q = $('q').value.trim();
    $('qClear').classList.toggle('hidden', !q);
    clearTimeout(searchTimer);
    if (q.length < 2) {
      searchToken++;
      lastQuery = '';
      $('searchHome').classList.remove('hidden');
      $('searchResults').replaceChildren();
      renderSearchHome();
      return;
    }
    $('searchHome').classList.add('hidden');
    renderLocal(q); // biblioteket direkt
    searchTimer = setTimeout(() => runSearch(q), immediate ? 0 : 450);
  }
  $('q').addEventListener('input', () => onQueryChange(false));
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); $('q').blur(); onQueryChange(true); });
  $('qClear').addEventListener('click', () => { $('q').value = ''; onQueryChange(); $('q').focus(); });

  qsa('#searchPills button').forEach((b) => b.addEventListener('click', () => {
    const on = !b.classList.contains('on');
    qsa('#searchPills button').forEach((x) => x.classList.remove('on'));
    const box = $('suggestions');
    if (!on) { box.classList.add('hidden'); return; }
    b.classList.add('on');
    box.replaceChildren(...SUGGEST[b.dataset.cat].map((s) => h('button', { onclick: () => { $('q').value = s; onQueryChange(true); } }, s)));
    box.classList.remove('hidden');
  }));
  // ── 🎲 Slumpa låt: viktat mot populära låtar, aldrig en som redan står i kön.
  // Valt snabbval (🇸🇪/🇬🇧/🕺/🎸) styr kategorin. Tomt bibliotek → slumpa ur förslagslistorna och sök.
  // Bortvalda låtar per telefon (localStorage) – visas inte igen inom 1 timme
  const REJECT_KEY = 'karaoke.rejected';
  const REJECT_MS = 60 * 60 * 1000;
  function getRejected() {
    let m = {};
    try { m = JSON.parse(localStorage.getItem(REJECT_KEY)) || {}; } catch { /* trasig data */ }
    const now = Date.now();
    for (const [id, at] of Object.entries(m)) if (now - at > REJECT_MS) delete m[id];
    return m;
  }
  function rejectSong(id) {
    const m = getRejected();
    m[id] = Date.now();
    localStorage.setItem(REJECT_KEY, JSON.stringify(m));
  }
  async function pickRandom(avoidId = null) {
    if (!libraryLoaded) await loadLibrary();
    const cat = document.querySelector('#searchPills button.on')?.dataset.cat || '';
    const busy = new Set([S.now?.id, ...(S.queue || []).map((e) => e.songId)].filter(Boolean));
    // Kvällens redan sjungna låtar (titel+artist från historiken) slumpas inte fram igen
    const sung = new Set((S.history || []).map((x) => `${fold(x.artist)}|${fold(x.title)}`));
    let pool = library.filter((s) => !busy.has(s.id) && (s.hasLyrics || s.type === 'video') && !sung.has(`${fold(s.artist)}|${fold(s.title)}`));
    if (cat) pool = pool.filter((s) => (s.tags || []).includes(cat));
    if (!pool.length) return null;
    const seen = getRejected();
    let fresh = pool.filter((s) => !seen[s.id]);
    if (!fresh.length) {
      toast('🎲 Du har sett alla låtar – blandar om från början');
      localStorage.removeItem(REJECT_KEY);
      fresh = pool.length > 1 ? pool.filter((s) => s.id !== avoidId) : pool; // aldrig samma två gånger i rad
    }
    // Äkta slump: alla låtar lika troliga (crypto om det finns)
    const rnd = () => (window.crypto?.getRandomValues ? window.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 : Math.random());
    return fresh[Math.floor(rnd() * fresh.length)];
  }
  async function surprise(prevId = null) {
    vibrate(20);
    const s = await pickRandom(prevId);
    if (s) rejectSong(s.id); // allt som visas spärras i 1 timme på den här telefonen – samma låt kommer inte tillbaka
    if (!s) {
      const cat = document.querySelector('#searchPills button.on')?.dataset.cat;
      const list = SUGGEST[cat] || Object.values(SUGGEST).flat();
      const q = list[Math.floor(Math.random() * list.length)];
      toast(`🎲 Biblioteket är tomt – vi söker på ”${q}”`);
      $('q').value = q;
      onQueryChange(true);
      return;
    }
    const item = { kind: 'library', songId: s.id, title: s.title, artist: s.artist };
    const again = h('button', { class: 'soft' }, '🎲 Slumpa igen');
    again.addEventListener('click', () => surprise(s.id));
    const add = h('button', { class: 'primary' }, '➕ Lägg i kön');
    add.addEventListener('click', () => { closeSheet(); openAddSheet(item); });
    openSheet(
      h('div', { class: 'dice-result' }, h('div', { class: 'dice-cover' }, coverEl(s.cover, s.artist, s.title)),
        h('small', { class: 'hint' }, '🎲 Slumpen har valt'), h('h2', {}, s.title), h('div', { class: 'sub' }, `${s.artist} · ${fmtTime(s.duration)}`)),
      h('div', { class: 'grid2' }, again, add));
  }
  $('btnRandom').addEventListener('click', () => surprise());

  // Kompatibilitet med tomma vyer som vill öppna en kategori
  function setSearchMode() {}

  function matchLibrary(q) {
    const toks = fold(q).split(/\s+/).filter((t) => t && t !== '-');
    if (!toks.length) return [];
    return library.filter((s) => { const hay = fold(`${s.artist} ${s.title}`); return toks.every((t) => hay.includes(t)); });
  }

  // Resultatsektioner: [lokal] [sjung med artist] [karaoke-text]
  const secLocal = h('div');
  const secLyrics = h('div');
  const secVideo = h('div');
  function mountSections() {
    if (secLocal.parentNode !== $('searchResults')) $('searchResults').replaceChildren(secLocal, secLyrics, secVideo);
  }
  const title = (icon, text, sub) => h('div', { class: 'res-head' }, h('div', { class: 'section-title' }, `${icon} ${text}`), sub ? h('small', { class: 'hint' }, sub) : null);

  // Direktknapp: lägg i kön med sparat namn, annars öppna arket
  function quickAdd(item, btn) {
    const name = (localStorage.getItem(SINGER_KEY) || '').trim();
    if (!name) { openAddSheet(item); return; }
    btn.disabled = true;
    btn.textContent = '…';
    addItem(item, { name, next: false })
      .then(() => { btn.textContent = '✓'; btn.classList.add('ok'); })
      .catch((e) => { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '＋'; });
  }
  const addBtn = (item) => {
    const b = h('button', { class: 'add', 'aria-label': 'Lägg i kön' }, '＋');
    b.addEventListener('click', (e) => { e.stopPropagation(); quickAdd(item, b); });
    return b;
  };

  function renderLocal(q) {
    mountSections();
    if (!libraryLoaded) { loadLibrary().then(() => { if ($('q').value.trim() === q) renderLocal(q); }); return; }
    const hits = matchLibrary(q).slice(0, 5);
    secLocal.replaceChildren(...(hits.length ? [title('⚡', 'Spela direkt', 'Finns redan på datorn'), ...hits.map((s) => {
      const item = { kind: 'library', songId: s.id, title: s.title, artist: s.artist };
      return h('div', { class: 'item', role: 'button', onclick: () => openAddSheet(item) }, coverEl(s.cover, s.artist, s.title),
        h('div', { class: 'meta' }, h('div', { class: 't' }, s.title), h('div', { class: 's' }, `${s.artist} · ${fmtTime(s.duration)}${s.type === 'video' && !s.hasLyrics ? ' · 📺' : ''}`)),
        addBtn(item));
    })] : []));
  }

  async function runSearch(q) {
    if (q === lastQuery) return;
    lastQuery = q;
    const token = ++searchToken;
    pushRecent(q);
    mountSections();
    secLyrics.replaceChildren(title('🎤', 'Sjung med artist'), h('div', { class: 'spinner' }));
    secVideo.replaceChildren();
    let res = [];
    try { res = await api(`/api/search/lyrics?q=${enc(q)}`); }
    catch (e) { if (token === searchToken) secLyrics.replaceChildren(title('🎤', 'Sjung med artist'), h('div', { class: 'empty' }, `😕 ${e.message}`)); }
    if (token !== searchToken) return;
    renderLyricsResults(q, res);
    loadVideos(q, token);
  }

  function versionTag(t) {
    const m = /\b(live|remaster(?:ed)?|acoustic|akustisk|demo|radio edit|remix|version)\b/i.exec(t || '');
    return m ? m[1].replace(/^./, (c) => c.toUpperCase()) : null;
  }

  function renderLyricsResults(q, res) {
    // Bara låtar med synkad text, dubbletter (samma artist+titel) slås ihop till den närmast "originalet"
    const seen = new Set();
    const synced = res.filter((r) => r.synced && !r.instrumental).filter((r) => {
      const k = `${fold(r.artist)}|${fold(r.title)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const shown = synced.slice(0, 6);
    const rest = synced.slice(6);
    const row = (r, i) => {
      const item = { kind: 'autotext', lrclibId: r.id, title: r.title, artist: r.artist, duration: r.duration };
      const tag = versionTag(r.title);
      return h('div', { class: 'item', role: 'button', onclick: () => openAddSheet(item) }, coverEl(null, r.artist, r.title, { lookup: i < 8 }),
        h('div', { class: 'meta' }, h('div', { class: 't' }, r.title, tag ? h('span', { class: 'badge' }, tag) : null),
          h('div', { class: 's' }, `${r.artist}${r.duration ? ` · ${fmtTime(r.duration)}` : ''}`)),
        addBtn(item));
    };
    const out = [title('🎤', 'Sjung med artist', 'Originallåten med text som fylls i takt')];
    if (shown.length) {
      out.push(...shown.map(row));
      if (rest.length) {
        const more = h('button', { class: 'more' }, `Visa ${rest.length} till`);
        more.addEventListener('click', () => { more.replaceWith(...rest.map((r, i) => row(r, i + 6))); });
        out.push(more);
      }
    } else {
      out.push(h('div', { class: 'nohit' }, h('b', {}, 'Ingen synkad text hittades'),
        h('span', {}, 'Prova en karaoke-video nedan, eller låt oss leta text på YouTube.'),
        h('button', { class: 'soft', onclick: () => openAddSheet({ kind: 'ytlyrics', query: q, title: q, artist: 'Text från YouTube' }) }, '🔎 Leta text på YouTube')));
    }
    secLyrics.replaceChildren(...out);
  }

  async function loadVideos(q, token) {
    secVideo.replaceChildren(title('📺', 'Karaoke-text', 'Karaokeversion utan sång'), h('div', { class: 'spinner' }));
    try {
      const res = await api(`/api/search/youtube?q=${enc(q)}`);
      if (token !== searchToken) return;
      if (!res.length) { secVideo.replaceChildren(title('📺', 'Karaoke-text'), h('div', { class: 'empty' }, 'Inga karaoke-videor hittades')); return; }
      secVideo.replaceChildren(title('📺', 'Karaoke-text', 'Karaokeversion utan sång'), ...res.slice(0, 5).map((r) => {
        const item = { kind: 'ytvideo', ...r, artist: r.channel };
        return h('div', { class: 'item', role: 'button', onclick: () => openAddSheet(item) },
          h('div', { class: 'cov wide' }, h('img', { src: r.thumbnail, alt: '', loading: 'lazy' })),
          h('div', { class: 'meta' }, h('div', { class: 't' }, r.title), h('div', { class: 's' }, `${r.channel} · ${fmtTime(r.duration)}`)),
          addBtn(item));
      }));
    } catch (e) {
      if (token === searchToken) secVideo.replaceChildren(title('📺', 'Karaoke-text'), h('div', { class: 'empty' }, `😕 ${e.message}`));
    }
  }

  // Gemensam köläggning (ark och snabbknapp)
  async function addItem(item, { name, next, inst, vid }) {
    localStorage.setItem(SINGER_KEY, name);
    if (item.kind === 'library') {
      const r = await new Promise((resolve, reject) => socket.emit('queue:add', { songId: item.songId, singer: name, next }, (x) => (x?.error ? reject(new Error(x.error)) : resolve(x))));
      toast(next ? '⏭️ Spelas härnäst!' : `🎤 ”${item.title}” tillagd i kön!`, 'ok');
      if (r?.ignoredNext) toast('Värdläge: låten lades i kön i turordning', '');
    } else {
      const map = {
        autotext: ['/api/request/autotext', { lrclibId: item.lrclibId, preferInstrumental: inst, withVideo: vid }],
        ytvideo: ['/api/request/ytvideo', { ytId: item.ytId, title: item.title, channel: item.channel, duration: item.duration }],
        ytlyrics: ['/api/request/ytlyrics', { query: item.query }],
      };
      const [url, body] = map[item.kind];
      const r = await api(url, { method: 'POST', body: { ...body, singer: name, next } });
      toast(r.fromLibrary ? `🎤 ”${item.title}” tillagd i kön!` : `⏳ ”${item.title}” hämtas – den dyker upp i kön`, 'ok');
      if (r.ignoredNext) toast('Värdläge: låten lades i kön i turordning', '');
    }
    vibrate(25);
  }

  function openAddSheet(item) {
    const singer = h('input', { type: 'text', placeholder: '🎤 Vem sjunger? (valfritt)', maxlength: '40', value: localStorage.getItem(SINGER_KEY) || '', autocomplete: 'off' });
    const opts = [];
    let inst = null; let vid = null;
    if (item.kind === 'autotext') {
      inst = h('input', { type: 'checkbox', checked: !!S.settings.preferInstrumental });
      vid = h('input', { type: 'checkbox', checked: S.settings.theme === 'video' });
      opts.push(h('label', { class: 'check' }, inst, '🎻 Föredra instrumental version (om längden matchar)'));
      opts.push(h('label', { class: 'check' }, vid, '🎬 Hämta musikvideo (för temat ”Musikvideo i bakgrunden”)'));
    } else if (item.kind === 'ytvideo') {
      opts.push(h('small', { class: 'hint' }, `Videon laddas ner i max ${S.settings.maxVideoHeight || 720}p (H.264) och spelas med inbränd text.`));
    } else if (item.kind === 'ytlyrics') {
      opts.push(h('small', { class: 'hint' }, 'Letar upp en text-video med undertexter och använder samma videos ljud, så att tidskoderna matchar. Kvaliteten kan variera.'));
    }
    const submit = async (next, btn) => {
      btn.disabled = true;
      try {
        await addItem(item, { name: singer.value.trim(), next, inst: inst?.checked, vid: vid?.checked });
        closeSheet();
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    };
    const okBtn = h('button', { class: 'primary' }, '➕ Lägg i kön');
    const nextBtn = h('button', { class: 'soft' }, '⏭️ Spela härnäst');
    okBtn.addEventListener('click', () => submit(false, okBtn));
    nextBtn.addEventListener('click', () => submit(true, nextBtn));
    openSheet(h('h2', {}, item.title), h('div', { class: 'sub' }, item.artist || ''),
      h('div', { class: 'stack' }, singer, ...opts, h('div', { class: 'grid2' }, okBtn, nextBtn)));
  }

  function hero(art, title, text, ctas = []) {
    return h('div', { class: 'hero' }, h('div', { class: 'art' }, art), h('h3', {}, title), h('div', {}, text),
      ctas.length ? h('div', { class: 'cta' }, ...ctas.map(([label, fn]) => h('button', { class: 'soft', onclick: fn }, label))) : null);
  }

  // ───────────────────────────── Bibliotek ─────────────────────────────
  async function loadLibrary() {
    try {
      library = await api('/api/library');
      libraryLoaded = true;
      renderLibrary();
    } catch (e) { $('libList').replaceChildren(h('div', { class: 'empty' }, e.message)); }
  }
  let libReloadTimer = null;
  socket.on('library:changed', () => { clearTimeout(libReloadTimer); libReloadTimer = setTimeout(() => { if (libraryLoaded) loadLibrary(); }, 600); });

  function libItem(s) {
    const edit = h('button', { class: 'mini', 'aria-label': 'Redigera', onclick: (e) => { e.stopPropagation(); ensureAdmin(() => openEditor(s.id)); } }, '✏️');
    return h('div', {
      class: 'item', role: 'button', tabindex: '0',
      onclick: () => openAddSheet({ kind: 'library', songId: s.id, title: s.title, artist: s.artist }),
    },
    coverEl(s.cover, s.artist, s.title),
    h('div', { class: 'meta' }, h('div', { class: 't' }, s.title),
      h('div', { class: 's' }, `${s.artist} · ${fmtTime(s.duration)} ${(s.tags || []).map((t) => TAG_ICON[t] || '').join('')}`)),
    h('div', { class: 'side' },
      s.type === 'video' && !s.hasLyrics ? h('span', { class: 'badge' }, '🎬 Video') : null,
      s.hasLyrics ? h('span', { class: `badge ${s.lyricsQuality === 'auto' ? 'warn' : 'ok'}` }, s.lyricsQuality === 'auto' ? '📝 Auto' : '📝 Text') : (s.type === 'audio' ? h('span', { class: 'badge warn' }, 'Ingen text') : null),
      edit));
  }

  function renderLibrary() {
    const q = $('libSearch').value;
    let list = q.trim() ? matchLibrary(q) : library;
    if (libTag === 'video') list = list.filter((s) => s.type === 'video');
    else if (libTag) list = list.filter((s) => (s.tags || []).includes(libTag));
    if (!list.length) {
      $('libList').replaceChildren(library.length
        ? h('div', { class: 'empty' }, 'Inga låtar matchar filtret.')
        : hero('📚🎶', 'Biblioteket är tomt', 'Allt du söker fram eller laddar upp sparas här.', [['🔍 Sök en låt', () => showView('search')], ['📁 Ladda upp en fil', () => showView('upload')]]));
      return;
    }
    $('libList').replaceChildren(h('div', { class: 'section-title' }, `${list.length} låt${list.length === 1 ? '' : 'ar'}`), ...list.slice(0, 300).map(libItem));
  }
  $('libSearch').addEventListener('input', throttle(renderLibrary, 150));
  qsa('#libPills button').forEach((b) => b.addEventListener('click', () => {
    libTag = b.dataset.tag;
    qsa('#libPills button').forEach((x) => x.classList.toggle('on', x === b));
    renderLibrary();
  }));

  // ───────────────────────────── Topplistor & historik ─────────────────────────────
  let libMode = 'all';
  qsa('#libMode button').forEach((b) => b.addEventListener('click', () => {
    libMode = b.dataset.mode;
    qsa('#libMode button').forEach((x) => x.classList.toggle('on', x === b));
    $('libAll').classList.toggle('hidden', libMode !== 'all');
    $('libStats').classList.toggle('hidden', libMode === 'all');
    if (libMode !== 'all') loadStats();
  }));
  const MEDAL = ['🥇', '🥈', '🥉'];
  const timeAgo = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'nyss';
    if (m < 60) return `${m} min sedan`;
    const h2 = Math.round(m / 60);
    if (h2 < 24) return `${h2} h sedan`;
    return new Date(ts).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  };
  function statRow(e, rankLabel, sub) {
    const s = e.song;
    const item = s ? { kind: 'library', songId: s.id, title: s.title, artist: s.artist } : null;
    return h('div', { class: `item${s ? '' : ' disabled'}`, role: 'button', onclick: () => item && openAddSheet(item) },
      h('div', { class: 'rank' }, rankLabel),
      coverEl(s?.cover, e.artist, e.title),
      h('div', { class: 'meta' }, h('div', { class: 't' }, e.title), h('div', { class: 's' }, sub)),
      item ? addBtn(item) : h('span', { class: 'badge' }, 'Borttagen'));
  }
  async function loadStats() {
    const box = $('libStats');
    box.replaceChildren(h('div', { class: 'spinner' }));
    const range = libMode === 'tonight' ? 'tonight' : libMode === 'alltime' ? 'all' : 'recent';
    try {
      const r = await api(`/api/stats?range=${range}`);
      if (!r.items.length) {
        box.replaceChildren(hero(range === 'tonight' ? '🔥🎤' : '🏆🎶', range === 'tonight' ? 'Inget sjunget ikväll än' : 'Ingen historik än',
          'Låtar räknas när de sjungits klart (eller minst 60 %).', [['🔍 Sök en låt', () => showView('search')]]));
        return;
      }
      if (range === 'recent') {
        box.replaceChildren(h('div', { class: 'section-title' }, 'Senast sjungna'), ...r.items.map((e) => statRow(e, '🎤', `${e.singer || 'Okänd'} · ${timeAgo(e.at)}`)));
        return;
      }
      const out = [h('div', { class: 'stat-head' }, h('b', {}, String(r.total)), range === 'tonight' ? ' låtar sjungna ikväll' : ' låtar sjungna totalt')];
      out.push(h('div', { class: 'section-title' }, range === 'tonight' ? '🔥 Kvällens mest sjungna' : '🏆 Alla tiders mest sjungna'));
      out.push(...r.items.map((e, i) => statRow(e, MEDAL[i] || `${i + 1}`, `${e.artist} · ${e.count} gång${e.count === 1 ? '' : 'er'}${e.singers.length ? ` · ${e.singers.join(', ')}` : ''}`)));
      if (r.singers?.length) {
        out.push(h('div', { class: 'section-title' }, range === 'tonight' ? '🎤 Kvällens sångare' : '🎤 Flitigaste sångarna'));
        out.push(h('div', { class: 'singers' }, ...r.singers.map((sg, i) => h('div', { class: 'singer' },
          h('span', {}, `${MEDAL[i] || `${i + 1}.`} ${sg.singer}`), h('small', {}, `${sg.count} låt${sg.count === 1 ? '' : 'ar'}${sg.applause ? ` · 👏 ${sg.applause}` : ''}`)))));
      }
      box.replaceChildren(...out);
    } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, e.message)); }
  }

  // ───────────────────────────── Kö ─────────────────────────────
  let lastQueueSig = '';
  function renderQueue() {
    const q = S.queue || [];
    // Struktur-signatur utan nedladdningsprocent: listan byggs bara om när ordning/innehåll ändras,
    // progress uppdateras på plats (annars kan tryck tappas mitt i en DOM-ersättning).
    const sig = JSON.stringify([q.map((e) => [e.qid, e.singer, e.title, e.ready, !!e.job, e.owner]), S.now?.qid, !!S.now, q.some((e) => e.ready), isGuest(), myOwner]);
    if (sig === lastQueueSig) {
      for (const e of q) {
        if (!e.job) continue;
        const row = document.querySelector(`[data-qid="${e.qid}"]`);
        if (!row) continue;
        row.querySelector('.jobtxt').textContent = `⏳ ${e.job.stage || 'Laddar…'} ${e.job.status === 'running' ? `${e.job.progress}%` : ''}`;
        row.querySelector('.jobbar i').style.width = `${e.job.progress || 0}%`;
      }
      return;
    }
    lastQueueSig = sig;
    const badge = $('queueBadge');
    badge.textContent = String(q.length);
    badge.classList.toggle('hidden', !q.length);

    const actions = [];
    const guest = isGuest();
    if (!S.now && q.some((e) => e.ready)) actions.push(h('button', { class: 'primary', onclick: () => socket.emit('player:cmd', { cmd: 'startNext' }, ackToast) }, '▶ Starta nästa'));
    if (S.now && !guest) {
      actions.push(h('button', { class: 'soft', onclick: () => socket.emit('player:cmd', { cmd: 'skip' }, ackToast) }, '⏭ Hoppa över'));
      const stop = h('button', { class: 'soft' }, '⏹ Stoppa');
      stop.addEventListener('click', () => armConfirm(stop, () => socket.emit('player:cmd', { cmd: 'stop' }, ackToast)));
      actions.push(stop);
    }
    $('queueActions').replaceChildren(...actions);

    const out = [];
    if (S.now) {
      out.push(h('div', { class: 'item q-now' }, coverEl(S.now.cover, S.now.artist, S.now.title),
        h('div', { class: 'meta' }, h('div', { class: 't' }, `Nu: ${S.now.title}`), h('div', { class: 's' }, `🎤 ${S.now.singer || 'Okänd'} · ${S.now.artist}`))));
    }
    if (!q.length) out.push(hero('🎤✨', 'Kön är tom', 'Var först upp på scenen!', [['🔍 Sök en låt', () => { showView('search'); $('q').focus(); }], ['🇸🇪 Prova en svensk klassiker', () => { showView('search'); qsa('#searchPills button')[0].click(); }]]));
    q.forEach((e, i) => {
      const job = e.job;
      const meta = h('div', { class: 'meta' },
        h('div', { class: 't' }, e.title),
        h('div', { class: 's' }, `🎤 ${e.singer || 'Okänd'}${e.artist ? ` · ${e.artist}` : ''}`),
        job ? h('div', { class: 's jobtxt' }, `⏳ ${job.stage || 'Laddar…'} ${job.status === 'running' ? `${job.progress}%` : ''}`) : null,
        job ? h('div', { class: 'jobbar' }, h('i', { style: `width:${job.progress || 0}%` })) : null);
      const mine = isMine(e);
      if (mine) meta.firstChild.append(' ', h('span', { class: 'badge ok' }, 'du'));
      out.push(h('div', { class: `item${mine ? ' mine' : ''}`, 'data-qid': e.qid }, h('div', { class: 'q-num' }, String(i + 1)), meta,
        h('div', { class: 'side' },
          !guest && i > 0 ? h('button', { class: 'mini', 'aria-label': 'Flytta upp', onclick: () => socket.emit('queue:move', { qid: e.qid, dir: 'up' }, ackToast) }, '▲') : null,
          !guest && i < q.length - 1 ? h('button', { class: 'mini', 'aria-label': 'Flytta ned', onclick: () => socket.emit('queue:move', { qid: e.qid, dir: 'down' }, ackToast) }, '▼') : null,
          !guest && e.ready ? h('button', { class: 'mini', 'aria-label': 'Spela nu', onclick: () => socket.emit('queue:playNow', { qid: e.qid }, ackToast) }, '▶') : null,
          !guest || mine ? h('button', { class: 'mini', 'aria-label': 'Ta bort', onclick: () => socket.emit('queue:remove', { qid: e.qid }, ackToast) }, '✕') : null)));
    });
    $('queueList').replaceChildren(...out);
  }

  // ───────────────────────────── Uppladdning ─────────────────────────────
  $('upMedia').addEventListener('change', (e) => {
    const f = e.target.files[0];
    $('upMediaLabel').textContent = f ? `✅ ${f.name}` : '🎵 Välj ljud- eller videofil';
    e.target.closest('.drop').classList.toggle('has', !!f);
  });
  $('upLrc').addEventListener('change', (e) => {
    const f = e.target.files[0];
    $('upLrcLabel').textContent = f ? `✅ ${f.name}` : '📝 Valfri .lrc-fil med synkad text';
    e.target.closest('.drop').classList.toggle('has', !!f);
  });
  $('uploadForm').singer.value = localStorage.getItem(SINGER_KEY) || '';
  $('uploadForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    if (!$('upMedia').files[0]) { toast('Välj en fil först', 'error'); return; }
    const fd = new FormData(form);
    fd.set('queue', $('upQueue').checked ? '1' : '0');
    localStorage.setItem(SINGER_KEY, form.singer.value.trim());
    const bar = $('upProgress');
    const fill = bar.querySelector('i');
    const label = bar.querySelector('span');
    bar.classList.remove('hidden');
    $('upBtn').disabled = true;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-client-id', clientId);
    if (pin) xhr.setRequestHeader('x-karaoke-pin', pin);
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const p = Math.round((ev.loaded / ev.total) * 100);
      fill.style.width = `${p}%`;
      label.textContent = p < 100 ? `Laddar upp… ${p}%` : '🔎 Läser taggar & söker text…';
    };
    xhr.onload = () => {
      $('upBtn').disabled = false;
      bar.classList.add('hidden');
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignoreras */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        toast(data.lyricsFound ? `✅ ”${data.song.title}” uppladdad – synkad text hittad!` : `✅ ”${data.song.title}” uppladdad – ingen synkad text (lägg till via ✏️)`, 'ok');
        if (data.queueError) toast(`Lades inte i kön: ${data.queueError}`, 'error');
        form.reset();
        form.singer.value = localStorage.getItem(SINGER_KEY) || '';
        $('upMedia').dispatchEvent(new Event('change'));
        $('upLrc').dispatchEvent(new Event('change'));
      } else toast(data.error || `Uppladdningen misslyckades (${xhr.status})`, 'error');
    };
    xhr.onerror = () => { $('upBtn').disabled = false; bar.classList.add('hidden'); toast('Nätverksfel vid uppladdning', 'error'); };
    xhr.send(fd);
  });

  // ───────────────────────────── Låt- & textredigerare ─────────────────────────────
  function estimatePlaybackTime() {
    const el = playback.paused ? 0 : ((Date.now() - playback.at) / 1000) * (S.settings.speed || 1);
    return playback.t + el;
  }

  async function openEditor(songId) {
    let song;
    try { song = await api(`/api/songs/${encodeURIComponent(songId)}`); } catch (e) { toast(e.message, 'error'); return; }
    const artist = h('input', { type: 'text', value: song.artist, placeholder: 'Artist' });
    const title = h('input', { type: 'text', value: song.title, placeholder: 'Titel' });
    const tagBoxes = Object.keys(TAG_NAME).map((t) => {
      const cb = h('input', { type: 'checkbox', checked: (song.tags || []).includes(t), value: t });
      return { t, cb, el: h('label', {}, cb, TAG_NAME[t]) };
    });
    const ta = h('textarea', { spellcheck: 'false', placeholder: '[00:12.30] Första raden…\n[00:15.80] Andra raden…', value: song.lrc || '' });
    const cands = h('div', { class: 'list' });
    const src = { lrclib: 'LRCLIB', upload: 'uppladdad .lrc', manual: 'manuell', 'youtube-subs': 'YouTube-undertexter' }[song.lyricsSource] || 'ingen';

    const fetchBtn = h('button', { class: 'soft' }, '🔄 Sök text på LRCLIB');
    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true;
      cands.replaceChildren(h('div', { class: 'spinner' }));
      try {
        const list = await api(`/api/songs/${song.id}/lyrics-candidates`, { method: 'POST', body: { artist: artist.value, title: title.value } });
        if (!list.length) cands.replaceChildren(h('div', { class: 'empty' }, 'Inga träffar på LRCLIB'));
        else cands.replaceChildren(...list.slice(0, 12).map((c) => h('button', {
          class: `item${c.synced ? '' : ' disabled'}`,
          onclick: async () => {
            if (!c.synced) return;
            try {
              const r = await api(`/api/songs/${song.id}/apply-lrclib`, { method: 'POST', body: { lrclibId: c.id } });
              ta.value = r.lrc; cands.replaceChildren(); toast('📝 Text hämtad och sparad', 'ok');
            } catch (e) { toast(e.message, 'error'); }
          },
        }, h('div', { class: 'meta' }, h('div', { class: 't' }, c.title), h('div', { class: 's' }, `${c.artist} · ${fmtTime(c.duration)}`)),
        h('span', { class: `badge ${c.synced ? 'ok' : 'warn'}` }, c.synced ? `✓ Synkad · ${song.duration && c.duration ? `Δ${Math.abs(c.duration - song.duration)} s` : ''}` : 'Ingen synk'))));
      } catch (e) { cands.replaceChildren(h('div', { class: 'empty' }, e.message)); }
      fetchBtn.disabled = false;
    });

    // Tap-synk: stämpla rader med aktuell uppspelningstid medan låten spelas
    const isNow = S.now?.id === song.id;
    let syncLine = 0;
    const syncInfo = h('small', { class: 'hint' });
    const lineList = () => ta.value.split('\n');
    const nextLineText = () => {
      const L = lineList();
      while (syncLine < L.length && (!L[syncLine].trim() || /^\[[a-z]+:/i.test(L[syncLine]))) syncLine++;
      const txt = L[syncLine]?.replace(/^(\[\d+:\d+(?:[.:]\d+)?\])+/, '') || '';
      syncInfo.textContent = syncLine < L.length ? `Nästa rad att stämpla: ”${txt.slice(0, 50)}”` : 'Alla rader stämplade ✅';
    };
    const stampBtn = h('button', { class: 'primary' }, '⏱ Stämpla rad');
    stampBtn.addEventListener('click', () => {
      const L = lineList();
      nextLineText();
      if (syncLine >= L.length) return;
      const tSec = Math.max(0, estimatePlaybackTime() - 0.12); // kompensera reaktionstid
      L[syncLine] = `[${fmtTs(tSec)}]${L[syncLine].replace(/^(\[\d+:\d+(?:[.:]\d+)?\])+/, '')}`;
      ta.value = L.join('\n');
      syncLine++;
      vibrate(15);
      nextLineText();
    });
    const syncFromCursor = h('button', { class: 'soft' }, '↧ Börja från markören');
    syncFromCursor.addEventListener('click', () => { syncLine = ta.value.slice(0, ta.selectionStart).split('\n').length - 1; nextLineText(); });

    const saveBtn = h('button', { class: 'primary' }, '💾 Spara');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await api(`/api/songs/${song.id}`, {
          method: 'PATCH',
          body: { title: title.value, artist: artist.value, tags: tagBoxes.filter((x) => x.cb.checked).map((x) => x.t), lrc: ta.value },
        });
        toast('💾 Låten sparad', 'ok');
        closeSheet();
      } catch (e) { toast(e.message, 'error'); saveBtn.disabled = false; }
    });
    const delBtn = h('button', { class: 'danger' }, '🗑️ Ta bort låt');
    delBtn.addEventListener('click', () => armConfirm(delBtn, async () => {
      try { await api(`/api/songs/${song.id}`, { method: 'DELETE' }); toast('🗑️ Låten borttagen', 'ok'); closeSheet(); }
      catch (e) { toast(e.message, 'error'); }
    }));

    openSheet(
      h('h2', {}, '✏️ Låt- & textredigerare'),
      h('div', { class: 'sub' }, `Textkälla: ${src}${song.offsetMs ? ` · sparad synk ${fmtSec(song.offsetMs)}` : ''}`),
      song.sync ? (() => {
        const sy = song.sync;
        const lbl = { high: 'hög', medium: 'medel', low: 'låg' }[sy.confidence] || '–';
        const cb = h('input', { type: 'checkbox', checked: !sy.disabled });
        cb.addEventListener('change', async () => {
          try { await api(`/api/songs/${song.id}`, { method: 'PATCH', body: { syncDisabled: !cb.checked } }); toast(cb.checked ? '🎯 Autosynk på för låten' : 'Autosynk av för låten', 'ok'); }
          catch (e) { toast(e.message, 'error'); cb.checked = !cb.checked; }
        });
        return h('div', { class: 'fallback' },
          h('div', {}, `🎯 Autosynk: säkerhet ${lbl}${sy.applied || sy.confidence !== 'low' ? ` · förskjutning ${fmtSec(sy.shiftSec * 1000)} · tempo ${(sy.scale * 100).toFixed(1).replace('.', ',')} %` : ''}${sy.applied ? ' · används' : ' · används inte'}`),
          sy.applied || sy.disabled ? h('label', { class: 'check' }, cb, 'Använd automatisk synk för den här låten') : null);
      })() : null,
      h('div', { class: 'stack' },
        h('div', { class: 'grid2' }, artist, title),
        h('div', { class: 'tagpick' }, ...tagBoxes.map((x) => x.el)),
        fetchBtn, cands,
        h('label', { class: 'hint' }, 'Rå LRC-text (klistra in eller redigera tidsstämplar):'),
        ta,
        isNow ? h('div', { class: 'fallback' }, h('b', {}, '🎯 Tap-synk (låten spelas nu)'), syncInfo, h('div', { class: 'grid2' }, syncFromCursor, stampBtn)) : null,
        h('div', { class: 'grid2' }, delBtn, saveBtn)),
    );
    if (isNow) nextLineText();
  }
  $('btnEditNow').addEventListener('click', () => {
    if (!S.now) { toast('Ingen låt spelas just nu'); return; }
    ensureAdmin(() => openEditor(S.now.id));
  });

  // ───────────────────────────── Systemkontroll ─────────────────────────────
  async function loadSystem() {
    const box = $('sysInfo');
    try {
      const s = await api('/api/system');
      const used = s.disk ? 1 - s.disk.free / s.disk.total : 0;
      const up = s.uptimeSec;
      const upStr = up > 86400 ? `${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} h` : `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min`;
      box.replaceChildren(...[
        h('div', {}, '💽 Disk: ', h('b', {}, s.disk ? `${fmtBytes(s.disk.free)} ledigt av ${fmtBytes(s.disk.total)}` : 'okänt')),
        s.disk ? h('div', { class: 'diskbar' }, h('i', { style: `width:${Math.round(used * 100)}%` })) : null,
        h('div', {}, '🎬 YouTube-cache: ', h('b', {}, `${fmtBytes(s.cacheBytes)} / ${fmtBytes(s.cacheMaxBytes)}`)),
        h('div', {}, '🎵 Bibliotek: ', h('b', {}, `${s.songCount} låtar · ${fmtBytes(s.songsBytes)}`)),
        h('div', {}, '⬇️ yt-dlp: ', h('b', {}, s.ytdlp), ' · Node ', h('b', {}, s.node)),
        h('div', {}, '⏱️ Drifttid: ', h('b', {}, upStr), ' · Last: ', h('b', {}, s.load.map((x) => x.toFixed(2).replace('.', ',')).join(' / '))),
        h('div', {}, '🧠 RAM: ', h('b', {}, `${fmtBytes(s.memFree)} ledigt av ${fmtBytes(s.memTotal)}`)),
        h('div', {}, '🌐 ', h('b', {}, s.remoteUrl), ` (${s.hostname})`),
        h('div', {}, '📺 TV: ', h('b', {}, s.tvConnected ? 'ansluten' : 'inte ansluten'), ' · 📱 Mobiler: ', h('b', {}, String(s.remotes)),
          s.analysisPending ? ` · 🎚️ Analyserar ${s.analysisPending} låtar…` : ''),
        s.systemd ? null : h('div', {}, '⚠️ Körs inte under systemd – ”Starta om” avslutar bara processen.'),
      ].filter(Boolean));
      $('cookieState').textContent = s.cookies ? '✓ inlagd' : 'ingen';
      if (s.sync) $('syncStatus').textContent = `Status: ${s.sync.analyzed}/${s.sync.withLyrics} låtar analyserade, ${s.sync.applied} justerade${s.sync.pending ? `, ${s.sync.pending} i kö` : ''}.`;
    } catch (e) { box.textContent = e.message; }
    loadSinks();
  }

  async function loadSinks() {
    const box = $('sinkList');
    try {
      const r = await api('/api/system/audio');
      if (!r.outputs.length) { box.replaceChildren(h('small', { class: 'hint' }, 'Inga ljudutgångar hittades')); return; }
      box.replaceChildren(...r.outputs.map((o) => {
        const radio = h('input', { type: 'radio', name: 'sink', checked: o.active });
        radio.addEventListener('change', async () => {
          box.classList.add('busy');
          try {
            const res = await api('/api/system/audio', { method: 'POST', body: { output: o.id } });
            toast(`🔊 Ljud via ${o.label.replace(/^\S+\s/, '')}`, 'ok');
            api('/api/system/audio/test', { method: 'POST' }).catch(() => {});
            if (res.kind === 'analog') toast('🎧 Analogt: använd högtalarens volym, inte TV:ns', 'info');
          } catch (e) { toast(e.message, 'error'); }
          box.classList.remove('busy');
          loadSinks();
        });
        const note = o.available === 'no' ? ' (ej inkopplad)' : o.needsProfile ? ' (avstängd – aktiveras vid val)' : '';
        return h('label', { class: `${o.active ? 'on' : ''}${o.available === 'no' ? ' dim' : ''}` }, radio, o.label, note ? h('small', {}, note) : null);
      }));
    } catch (e) { box.replaceChildren(h('small', { class: 'hint' }, e.message)); }
  }
  $('btnSinkRefresh').addEventListener('click', loadSinks);
  $('btnTestTone').addEventListener('click', async () => {
    try { await api('/api/system/audio/test', { method: 'POST' }); toast('🔔 Testljud skickat – hörs tre toner?', 'ok'); }
    catch (e) { toast(e.message, 'error'); }
  });
  $('cookieFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await api('/api/system/cookies', { method: 'POST', body: { text: await f.text() } }); toast('🍪 cookies.txt sparad', 'ok'); loadSystem(); }
    catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  });
  $('btnCookieDel').addEventListener('click', (e) => armConfirm(e.currentTarget, async () => {
    try { await api('/api/system/cookies', { method: 'DELETE' }); toast('🍪 cookies borttagna', 'ok'); loadSystem(); } catch (err) { toast(err.message, 'error'); }
  }));
  $('btnSysRefresh').addEventListener('click', loadSystem);
  $('btnClearCache').addEventListener('click', (e) => armConfirm(e.currentTarget, async () => {
    try { const r = await api('/api/system/clear-cache', { method: 'POST' }); toast(`🧹 Rensade ${r.removed} videor (${fmtBytes(r.size)} kvar)`, 'ok'); loadSystem(); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $('btnRestart').addEventListener('click', (e) => armConfirm(e.currentTarget, async () => {
    try { await api('/api/system/restart', { method: 'POST' }); toast('🔁 Tjänsten startar om – återansluter…'); }
    catch (err) { toast(err.message, 'error'); }
  }));

  // ───────────────────────────── Socket ─────────────────────────────
  function setConn(ok, text) {
    $('conn').className = `conn ${ok ? 'ok' : 'bad'}`;
    $('conn').querySelector('span').textContent = text;
  }
  socket.on('connect', () => {
    socket.emit('hello', { role: 'remote', clientId });
    if (pin) socket.emit('auth', { pin }, (r) => { admin = !!r?.ok; if (!r?.ok) { pin = ''; sessionStorage.removeItem('karaoke.pin'); } renderLock(); });
  });
  socket.on('disconnect', () => setConn(false, 'Frånkopplad – återansluter…'));
  socket.on('state', (s) => {
    S = s;
    playback = { ...s.playback, at: Date.now() };
    setConn(true, s.tvConnected ? 'Ansluten · TV ✓' : 'Ansluten · TV saknas');
    renderNow(); renderQueue(); renderSettings(); renderOffset(); renderLock();
  });
  socket.on('settings', (s) => { S.settings = s; renderSettings(); renderNow(); lastQueueSig = ''; renderQueue(); });
  socket.on('me', (m) => {
    myOwner = m.owner;
    if (m.admin) admin = true;
    lastQueueSig = ''; renderQueue(); renderNow(); renderLock();
    if (HOST) setTimeout(hostGate, 400); // vänta in ev. PIN-svar
  });
  socket.on('update:stage', ({ stage }) => { if (HOST) $('updInfo').textContent = `⏳ ${stage}`; });

  // ───────────────────────────── Namn ─────────────────────────────
  // Frågas direkt när mobilen ansluter, så att namnet syns stort på TV:n när det blir ens tur.
  const myName = () => (localStorage.getItem(SINGER_KEY) || '').trim();
  function renderMe() {
    $('meName').textContent = myName() || 'Ange namn';
    const f = $('uploadForm');
    if (f?.singer && !f.singer.value) f.singer.value = myName();
  }
  function askName(first = false) {
    const input = h('input', { type: 'text', placeholder: 'Ditt namn', maxlength: '40', value: myName(), autocomplete: 'given-name', enterkeyhint: 'done' });
    const save = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      localStorage.setItem(SINGER_KEY, v);
      renderMe();
      closeSheet();
      lastQueueSig = ''; renderQueue(); renderMyTurn();
      toast(`👋 Hej ${v}! Ditt namn visas stort på TV:n när det är din tur.`, 'ok');
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    openSheet(
      h('div', { class: 'welcome' }, h('div', { class: 'art' }, first ? '🎤✨' : '🎤'),
        h('h2', {}, first ? 'Välkommen till karaoke!' : 'Byt namn'),
        h('div', { class: 'sub' }, 'Vad heter du? Namnet visas på TV:n när det börjar bli din tur.')),
      h('div', { class: 'stack' }, input, h('button', { class: 'primary wide', onclick: save }, first ? 'Nu kör vi! 🎶' : 'Spara')));
    setTimeout(() => input.focus(), 300);
  }
  $('meChip').addEventListener('click', () => askName(false));
  renderMe();
  if (!HOST && !myName()) setTimeout(() => askName(true), 600);

  // ───────────────────────────── Värdpanel ─────────────────────────────
  let hostReady = false;
  function hostGate() {
    if (admin) {
      document.body.classList.remove('host-locked');
      if (!hostReady) { hostReady = true; $('adv').open = true; showView('queue'); $('nowBar').classList.add('open'); loadSystem(); loadUpdate(); loadAutostart(); }
      return;
    }
    document.body.classList.add('host-locked');
    if (S.pinRequired) requestPin(() => hostGate());
    else openSheet(h('h2', {}, '🔒 Värdpanelen'), h('div', { class: 'sub' }, 'Öppna värdpanelen på karaokedatorn (http://localhost:3000/host), eller sätt en PIN i /etc/default/lan-karaoke för att använda den från en annan dator.'));
  }

  async function loadUpdate() {
    const box = $('updInfo');
    let r;
    try { r = await api('/api/system/update'); }
    catch (e) {
      box.replaceChildren(h('div', {}, `⚠️ ${e.message}`));
      $('btnUpdApply').disabled = true;
      return;
    }
    const cur = r.current;
    const short = (sha) => (sha ? sha.slice(0, 7) : 'lokal kopia');
    const when = (d) => (d ? new Date(d).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '');
    box.replaceChildren(
      h('div', {}, '📦 Installerad: ', h('b', {}, `v${cur.version} · ${short(cur.sha)}`), cur.date ? ` (${when(cur.date)})` : ''),
      h('div', {}, '🌐 GitHub: ', h('b', {}, `${r.repo} @ ${r.branch}`)),
      h('div', {}, '🆕 Senaste: ', h('b', {}, short(r.latest.sha)), ` · ${when(r.latest.date)} · ${r.latest.message || ''}`),
      h('div', {}, r.available ? h('b', { style: 'color:var(--ok)' }, '✨ Ny version finns!') : '✅ Du har senaste versionen'));
    $('btnUpdApply').disabled = !r.available;
    $('btnRollback').classList.toggle('hidden', !cur.hasBackup);
    renderAutoUpd(r.auto);
  }
  function renderAutoUpd(a) {
    const el = $('autoUpdInfo');
    if (!a || !a.enabled) { el.textContent = 'Av som standard. Kollar GitHub varje timme och installerar bara när det varit lugnt i 15 min (ingen låt spelas, tom kö, inga nedladdningar). Kön och inställningar sparas; ↩️ ångrar.'; return; }
    const t = (ms) => new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    el.textContent = !a.repo ? '⚠️ UPDATE_REPO saknas i /etc/default/lan-karaoke'
      : a.lastError ? `⚠️ Senaste försöket misslyckades: ${a.lastError}`
      : a.pending ? `⏳ ${a.pending.sha.slice(0, 7)} installeras när det varit lugnt${a.quietInMin ? ` (om ≥ ${a.quietInMin} min)` : ''}`
      : a.lastCheck ? `✅ På · senast kollat ${t(a.lastCheck)} · nästa koll inom en timme` : '✅ På · första kollen sker inom några minuter';
  }
  $('btnUpdCheck').addEventListener('click', loadUpdate);
  document.querySelector('[data-setting="autoUpdate"]').addEventListener('change', () => setTimeout(loadUpdate, 4000));

  async function loadAutostart() {
    try { $('autostartToggle').checked = (await api('/api/system/autostart')).enabled; } catch { /* inte värd */ }
  }
  $('autostartToggle').addEventListener('change', async (e) => {
    try {
      const r = await api('/api/system/autostart', { method: 'POST', body: { enabled: e.target.checked } });
      e.target.checked = r.enabled;
      toast(r.enabled ? '✅ TV-vyn startar automatiskt med datorn' : '⏸️ Autostart avstängd', 'ok');
    } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
  });
  $('btnUpdApply').addEventListener('click', (e) => armConfirm(e.currentTarget, async () => {
    $('btnUpdApply').disabled = true;
    try {
      const r = await api('/api/system/update', { method: 'POST' });
      $('updInfo').textContent = r.updated ? '✅ Installerad – tjänsten startar om. Sidan laddas om automatiskt…' : 'Ingen ny version.';
      if (r.updated) setTimeout(() => location.reload(), 8000);
    } catch (err) { toast(err.message, 'error'); loadUpdate(); }
  }));
  $('btnRollback').addEventListener('click', (e) => armConfirm(e.currentTarget, async () => {
    try { await api('/api/system/rollback', { method: 'POST' }); $('updInfo').textContent = '↩️ Återställd – startar om…'; setTimeout(() => location.reload(), 8000); }
    catch (err) { toast(err.message, 'error'); }
  }));
  socket.on('offset', ({ liveOffsetMs }) => { S.liveOffsetMs = liveOffsetMs; renderOffset(); });
  socket.on('playback', (p) => {
    playback = { t: p.t, d: p.d, paused: p.paused, lat: p.lat || 0, at: Date.now() };
    if (p.phase) S.phase = p.phase;
    renderProgress();
    setToggleIcons();
  });
  socket.on('toast', ({ type, msg }) => toast(msg, type === 'error' ? 'error' : ''));

  renderSearchHome();
})();
