// LAN Karaoke – TV-vy (Chromium kiosk). All ljud-DSP körs här (AudioWorklet kräver secure
// context = localhost). Mobilen skickar bara inställningar via servern.
import { parseLrc } from '/lrc.js';

const $ = (id) => document.getElementById(id);
const audioEl = $('audio');
const videoEl = $('video');
const socket = window.io({ transports: ['websocket', 'polling'], autoConnect: false });

let settings = {};
let snapshot = null;
let liveOffsetMs = 0;
let current = null; // { song, singer, qid, mode }
let media = audioEl;
let loadToken = 0;
let introActive = false;
let celebrating = false;
let videoFullTimer = null;

// ───────────────────────────── Ljudmotor ─────────────────────────────
const engine = {
  ctx: null, nodes: {}, pitch: null, analyser: null, bins: null,

  async init() {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    const n = this.nodes;
    const srcA = ctx.createMediaElementSource(audioEl);
    const srcV = ctx.createMediaElementSource(videoEl);
    n.norm = ctx.createGain(); // loudness-normalisering per låt (EBU R128, analyserad på servern)
    srcA.connect(n.norm);
    srcV.connect(n.norm);
    n.input = ctx.createGain();
    n.norm.connect(n.input);

    // Sångdämpning 2.0 (spektral, se vocal-worklet.js). Saknas AudioWorklet → ingen dämpning.
    n.mono = ctx.createGain();
    this.vocal = null;
    try {
      await ctx.audioWorklet.addModule('/vocal-worklet.js');
      this.vocal = new AudioWorkletNode(ctx, 'vocal-reducer', { outputChannelCount: [2] });
      this.vocal.port.onmessage = (e) => { if ('mono' in e.data) { this.vocalMono = e.data.mono; socket.emit('tv:vocalMono', { mono: e.data.mono }); } };
      n.input.connect(this.vocal);
      this.vocal.connect(n.mono);
    } catch (e) {
      console.warn('Sångdämpning ej tillgänglig:', e);
      n.input.connect(n.mono);
    }
    let last = n.mono;

    try {
      await ctx.audioWorklet.addModule('/pitch-worklet.js');
      this.pitch = new AudioWorkletNode(ctx, 'pitch-shifter', { outputChannelCount: [2] });
      last.connect(this.pitch);
      last = this.pitch;
    } catch (e) {
      console.warn('Pitch shift ej tillgänglig (kräver localhost/https):', e);
      showStatus('Tonartsändring kräver att TV:n körs på localhost');
    }

    n.low = ctx.createBiquadFilter(); n.low.type = 'lowshelf'; n.low.frequency.value = 180;
    n.midEq = ctx.createBiquadFilter(); n.midEq.type = 'peaking'; n.midEq.frequency.value = 1000; n.midEq.Q.value = 0.9;
    n.high = ctx.createBiquadFilter(); n.high.type = 'highshelf'; n.high.frequency.value = 4500;
    n.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.78;
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    last.connect(n.low); n.low.connect(n.midEq); n.midEq.connect(n.high); n.high.connect(n.master);
    n.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.apply(settings);
  },

  apply(s) {
    if (!this.ctx || !this.nodes.master) return; // init pågår
    const t = this.ctx.currentTime;
    const n = this.nodes;
    const vol = s.muted ? 0 : Math.pow(s.volume ?? 0.85, 2);
    n.master.gain.setTargetAtTime(vol, t, 0.05);
    if (this.vocal) this.vocal.parameters.get('amount').setTargetAtTime(s.vocalReduce ?? 0, t, 0.05);
    n.mono.channelCount = s.mono ? 1 : 2;
    n.mono.channelCountMode = s.mono ? 'explicit' : 'max';
    n.low.gain.setTargetAtTime(s.eqLow || 0, t, 0.05);
    n.midEq.gain.setTargetAtTime(s.eqMid || 0, t, 0.05);
    n.high.gain.setTargetAtTime(s.eqHigh || 0, t, 0.05);
    if (this.pitch) this.pitch.parameters.get('ratio').setValueAtTime(Math.pow(2, (s.pitch || 0) / 12), t);
    this.applyGain();
  },

  // Fördröjning från mediaposition till högtalare: webbläsarens ljudbuffert + utgång (+ tonartsändringens korn ≈ 37 ms)
  latency() {
    const c = this.ctx;
    if (!c) return 0;
    const pitchDelay = this.pitch && (settings.pitch || 0) !== 0 ? (2 + 0.035 * c.sampleRate) / c.sampleRate : 0;
    const vocalDelay = this.vocal ? 2048 / c.sampleRate : 0; // STFT-fönstret (alltid i kedjan → konstant)
    return (c.baseLatency || 0) + (c.outputLatency || 0) + pitchDelay + vocalDelay;
  },

  songGainDb: 0,
  applyGain() {
    if (!this.nodes.norm) return;
    const db = settings.normalize === false ? 0 : this.songGainDb;
    this.nodes.norm.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.1);
  },

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* ignoreras */ } }
    return this.ctx?.state === 'running';
  },

  // Syntetiserad fanfar + applåd – inga ljudfiler behövs
  fanfare() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const out = ctx.createGain();
    out.gain.value = settings.muted ? 0 : 0.35 * Math.pow(settings.volume ?? 0.85, 2);
    out.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.05;
    const notes = [[523.25, 0, 0.16], [659.25, 0.16, 0.16], [783.99, 0.32, 0.16], [1046.5, 0.5, 0.7], [783.99, 0.5, 0.7], [659.25, 0.5, 0.7]];
    for (const [f, start, len] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + start);
      g.gain.linearRampToValueAtTime(0.5, t0 + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + start + len);
      o.connect(g).connect(out);
      o.start(t0 + start);
      o.stop(t0 + start + len + 0.05);
    }
    // Applåd: brus genom bandpass med slumpmässiga transienter
    const dur = 3;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let env = 0;
    for (let i = 0; i < d.length; i++) {
      if (Math.random() < 0.0016) env = 0.6 + Math.random() * 0.4;
      env *= 0.9965;
      const fade = Math.min(1, i / (ctx.sampleRate * 0.3)) * Math.min(1, (d.length - i) / (ctx.sampleRate * 1.2));
      d[i] = (Math.random() * 2 - 1) * (0.25 + env) * fade;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.6;
    const ag = ctx.createGain(); ag.gain.value = 0.6;
    src.connect(bp).connect(ag).connect(out);
    src.start(t0 + 0.4);
    setTimeout(() => out.disconnect(), (dur + 1.5) * 1000);
  },
};

// ───────────────────────────── Låttextmotor ─────────────────────────────
const lyr = { lines: [], idx: -2, prevIdx: -2, wordEls: [], wordState: [], breakKey: '', on: false };

function prepareLyrics(lrcText) {
  const parsed = parseLrc(lrcText || '');
  const lines = parsed.lines;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const nextT = i + 1 < lines.length ? lines[i + 1].t : l.t + 8;
    const gap = Math.max(0.3, nextT - l.t);
    const chars = l.text.replace(/\s/g, '').length;
    const sweep = gap <= 8 ? gap * 0.94 : Math.min(gap, Math.max(2.5, chars * 0.11));
    l.end = l.t + sweep;
    l.gap = gap;
    const tokens = l.words ? l.words.map((w) => ({ text: w.text, t: w.t })) : l.text.split(/(?<=\s)/).filter(Boolean).map((text) => ({ text }));
    const weight = (s) => Math.max(1, s.replace(/\s/g, '').length) + 0.5;
    if (l.words) {
      // Grupper med samma tidsstämpel fördelas efter teckenvikt fram till nästa distinkta tid
      let i0 = 0;
      while (i0 < tokens.length) {
        let i1 = i0;
        while (i1 + 1 < tokens.length && tokens[i1 + 1].t === tokens[i0].t) i1++;
        const gs = tokens[i0].t;
        let ge = i1 + 1 < tokens.length ? tokens[i1 + 1].t : Math.max(l.end, gs + 0.6);
        if (ge <= gs) ge = gs + 0.4;
        const total = tokens.slice(i0, i1 + 1).reduce((a, w) => a + weight(w.text), 0);
        let acc = gs;
        for (let k = i0; k <= i1; k++) {
          const dur = ((ge - gs) * weight(tokens[k].text)) / total;
          tokens[k].ws = acc; tokens[k].we = acc + dur; acc += dur;
        }
        i0 = i1 + 1;
      }
    } else {
      const total = tokens.reduce((a, w) => a + weight(w.text), 0) || 1;
      let acc = l.t;
      for (const w of tokens) { const dur = (sweep * weight(w.text)) / total; w.ws = acc; w.we = acc + dur; acc += dur; }
    }
    l.tokens = tokens;
  }
  lyr.lines = lines;
  lyr.idx = -2;
  lyr.prevIdx = -2;
  lyr.breakKey = '';
  return lines.length > 0;
}

function findLineIdx(t) {
  const L = lyr.lines;
  let i = lyr.idx < 0 ? -1 : lyr.idx;
  if (i >= 0 && t < L[i].t) { // bakåt (seek/offset): binärsökning
    let lo = 0, hi = L.length - 1; i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
    return i;
  }
  while (i + 1 < L.length && L[i + 1].t <= t) i++;
  return i;
}

const nextTextIdx = (from) => { for (let j = from; j < lyr.lines.length; j++) if (lyr.lines[j].text) return j; return -1; };
const prevTextIdx = (from) => { for (let j = from; j >= 0; j--) if (lyr.lines[j].text) return j; return -1; };

function setLineText(el, text) { if (el.textContent !== text) el.textContent = text; }
const VOICE_LABEL = { 1: 'RÖST 1', 2: 'RÖST 2', 3: 'RÖST 3', all: 'ALLA' };
function setVoice(el, voice) {
  if (voice) { el.dataset.voice = voice; if (el.id === 'lCur') el.dataset.vlabel = VOICE_LABEL[voice] || ''; }
  else { delete el.dataset.voice; delete el.dataset.vlabel; }
}

function renderLines(idx, t) {
  lyr.idx = idx;
  const L = lyr.lines;
  const cur = idx >= 0 ? L[idx] : null;
  const curEl = $('lCur');
  const n1 = nextTextIdx(idx + 1);
  const n2 = n1 >= 0 ? nextTextIdx(n1 + 1) : -1;
  const p = prevTextIdx(cur && cur.text ? idx - 1 : idx);
  setLineText($('lPrev'), p >= 0 ? L[p].text : '');
  setLineText($('lNext'), n1 >= 0 ? L[n1].text : '');
  setLineText($('lNext2'), n2 >= 0 ? L[n2].text : '');
  setVoice($('lCur'), cur && cur.text ? cur.voice : null);
  setVoice($('lNext'), n1 >= 0 ? L[n1].voice : null);
  setVoice($('lPrev'), p >= 0 ? L[p].voice : null);
  // Rulla som en teleprompter bara vid naturligt radbyte framåt (inte vid seek)
  if (idx === lyr.prevIdx + 1 || (cur && !cur.text)) {
    const st = $('lyricsStack');
    st.classList.remove('scroll'); void st.offsetWidth; st.classList.add('scroll');
  }
  lyr.prevIdx = idx;
  curEl.textContent = '';
  lyr.wordEls = [];
  lyr.wordState = [];
  if (cur && cur.text) {
    const frag = document.createDocumentFragment();
    for (const tok of cur.tokens) {
      const s = document.createElement('span');
      s.className = 'w';
      s.textContent = tok.text;
      frag.appendChild(s);
      lyr.wordEls.push(s);
      lyr.wordState.push(0);
    }
    curEl.appendChild(frag);
    curEl.classList.remove('enter');
    void curEl.offsetWidth; // starta om animationen
    curEl.classList.add('enter');
  }
  updateWords(t);
}

function updateWords(t) {
  const cur = lyr.idx >= 0 ? lyr.lines[lyr.idx] : null;
  if (!cur || !cur.text) return;
  const toks = cur.tokens;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    const st = t >= tok.we ? 2 : t >= tok.ws ? 1 : 0;
    const el = lyr.wordEls[k];
    if (st !== lyr.wordState[k]) {
      lyr.wordState[k] = st;
      el.className = st === 2 ? 'w done' : st === 1 ? 'w act' : 'w';
    }
    if (st === 1) el.style.setProperty('--p', ((t - tok.ws) / (tok.we - tok.ws)).toFixed(3));
  }
}

function updateBreak(t) {
  const L = lyr.lines;
  const idx = lyr.idx;
  const cur = idx >= 0 ? L[idx] : null;
  const j = nextTextIdx(idx + 1);
  const inBreak = !cur || !cur.text || t > cur.end + 0.35;
  let key = 'none';
  let remaining = 0;
  if (inBreak && j >= 0) {
    remaining = L[j].t - t;
    const breakStart = cur && cur.text ? cur.end : (cur ? cur.t : 0);
    const breakLen = L[j].t - breakStart;
    if (breakLen > 8 || (!cur && L[j].t > 3)) key = remaining <= 3.2 ? 'count' : 'inst';
  } else if (inBreak && j < 0 && cur && t > cur.end + 2) key = 'outro';
  if (key !== lyr.breakKey) {
    lyr.breakKey = key;
    $('instrumental').classList.toggle('hidden', !(key === 'inst' || key === 'outro'));
    $('instrumental').textContent = key === 'outro' ? '♪ ♪ ♪' : (!cur ? '♪ Intro ♪' : '♪ Instrumentalt ♪');
    $('countdown').classList.toggle('hidden', key !== 'count');
    $('lCur').classList.toggle('hidden', key === 'inst' || key === 'count');
  }
  if (key === 'count') {
    const lit = Math.min(3, Math.max(0, 3 - Math.floor(remaining)));
    const dots = $('countdown').querySelectorAll('b');
    dots.forEach((d, i) => d.classList.toggle('lit', i < lit));
    const n = String(Math.max(1, Math.ceil(remaining)));
    if ($('cdNum').textContent !== n) $('cdNum').textContent = n;
    $('cdBar').style.transform = `scaleX(${Math.max(0, Math.min(1, remaining / 3.2)).toFixed(3)})`;
  }
}

// ───────────────────────────── Visualizer ─────────────────────────────
const viz = $('viz');
const vctx = viz.getContext('2d');
let vizGrad = null;
let vizFrame = 0;
function buildVizGradient() {
  const cs = getComputedStyle(document.body);
  vizGrad = vctx.createLinearGradient(0, viz.height, 0, 0);
  vizGrad.addColorStop(0, cs.getPropertyValue('--accent2').trim() || '#00e5ff');
  vizGrad.addColorStop(0.6, cs.getPropertyValue('--accent').trim() || '#ff3df2');
  vizGrad.addColorStop(1, cs.getPropertyValue('--fill2').trim() || '#fff');
}
function drawViz() {
  if (!engine.analyser || (vizFrame++ & 1)) return; // 30 fps räcker
  const { bins } = engine;
  engine.analyser.getByteFrequencyData(bins);
  const W = viz.width, H = viz.height;
  vctx.clearRect(0, 0, W, H);
  if (!vizGrad) buildVizGradient();
  vctx.fillStyle = vizGrad;
  const bars = 64;
  const usable = bins.length * 0.7;
  const bw = W / bars;
  for (let i = 0; i < bars; i++) {
    const idx = Math.floor(Math.pow(i / bars, 1.6) * usable) + 1;
    const v = bins[idx] / 255;
    const h = Math.max(2, v * v * H * 0.95);
    // spegla från mitten för symmetri
    const xL = W / 2 - (i + 1) * (bw / 2) * 1;
    const xR = W / 2 + i * (bw / 2);
    vctx.fillRect(xL, H - h, bw / 2 - 2, h);
    vctx.fillRect(xR, H - h, bw / 2 - 2, h);
  }
}

// ───────────────────────────── Bakgrund (omslag) ─────────────────────────────
const bgArt = $('bgArt');
function setCoverBackground(url) {
  const ctx2 = bgArt.getContext('2d');
  bgArt.classList.remove('on');
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    // 32×18-canvas uppskalad av webbläsaren = gratis "blur" utan filter-kostnad
    const r = Math.max(bgArt.width / img.width, bgArt.height / img.height);
    const w = img.width * r, h = img.height * r;
    ctx2.clearRect(0, 0, bgArt.width, bgArt.height);
    ctx2.drawImage(img, (bgArt.width - w) / 2, (bgArt.height - h) / 2, w, h);
    bgArt.classList.add('on');
  };
  img.src = url;
}

// ───────────────────────────── Omslag/initialer ─────────────────────────────
function initials(text) {
  const words = (text || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase();
}
function hueOf(text) { let h = 0; for (const c of text || '') h = (h * 31 + c.codePointAt(0)) % 360; return h; }
function setCover(img, ph, url, artist, title) {
  ph.textContent = initials(artist || title);
  ph.style.setProperty('--h', hueOf(artist || title));
  if (url) {
    img.style.visibility = 'hidden';
    img.onload = () => { img.style.visibility = 'visible'; };
    img.onerror = () => { img.style.visibility = 'hidden'; };
    img.src = url;
  } else { img.removeAttribute('src'); img.style.visibility = 'hidden'; }
}

// ───────────────────────────── Temaeffekter ─────────────────────────────
(function buildFx() {
  const fx = $('fx');
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('i');
    p.className = 'p';
    p.style.setProperty('--x', `${(Math.random() * 96 + 2).toFixed(1)}%`);
    p.style.setProperty('--y', `${(Math.random() * 70 + 3).toFixed(1)}%`);
    p.style.setProperty('--s', `${(0.8 + Math.random() * 1.4).toFixed(2)}vw`);
    p.style.setProperty('--d', `${(2.5 + Math.random() * 3).toFixed(2)}s`);
    p.style.setProperty('--dl', `${(-Math.random() * 5).toFixed(2)}s`);
    fx.appendChild(p);
  }
})();

// ───────────────────────────── UI-hjälp ─────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}
function showStatus(msg) { $('status').textContent = msg; }

function applySettings(s) {
  settings = s || {};
  document.body.dataset.theme = settings.theme || 'neon';
  document.body.dataset.size = settings.textSize || 'normal';
  document.body.classList.toggle('no-qr', !settings.qrVisible);
  $('stage').style.setProperty('--overscan', `${settings.overscan || 0}%`);
  for (const el of [audioEl, videoEl]) {
    el.preservesPitch = true;
    el.playbackRate = settings.speed || 1;
  }
  engine.apply(settings);
  if (settings.theme !== lastTheme) {
    lastTheme = settings.theme;
    vizGrad = null;
    if (current) applyMode(); // bara vid temabyte – annars nollställs video-läget vid varje state
  }
}
let lastTheme = null;

let lastQrUrl = '';
let lastWifiKey = '';
function updateWifi(wifi, visible) {
  const show = !!wifi && visible;
  $('wifiCard').classList.toggle('hidden', !show);
  $('appStep').textContent = show ? '2 · Välj låt' : 'Välj låt';
  if (!show) return;
  const key = `${wifi.ssid}|${wifi.password}`;
  if (key === lastWifiKey) return;
  lastWifiKey = key;
  $('qrWifi').src = `/api/wifi.svg?v=${encodeURIComponent(key).length}${Date.now() % 1000}`;
  const t = $('wifiText');
  t.textContent = '';
  const b = document.createElement('b');
  b.textContent = wifi.ssid;
  t.append('Nätverk: ', b);
  if (wifi.password) { t.append(document.createElement('br'), 'Lösenord: '); const p = document.createElement('b'); p.textContent = wifi.password; t.append(p); }
}

function updateQr(url) {
  if (!url || url === lastQrUrl) return;
  lastQrUrl = url;
  const src = `/api/qr.svg?u=${encodeURIComponent(url)}`;
  $('qrSmall').src = src;
  $('qrBig').src = src;
  const pretty = url.replace(/^https?:\/\//, '');
  $('qrUrlSmall').textContent = pretty;
  $('qrUrlBig').textContent = pretty;
}

function renderQueueInfo() {
  if (!snapshot) return;
  const q = snapshot.queue || [];
  const next = q[0];
  const chip = $('nextChip');
  if (current && next) {
    chip.classList.remove('hidden');
    $('nextWho').textContent = next.singer || 'Okänd sångare';
    $('nextWhat').textContent = `– ${next.title}${next.ready ? '' : ' (laddar…)'}`;
  } else chip.classList.add('hidden');

  const totalSec = q.reduce((a, e) => a + (e.duration || 210) + (snapshot.introSeconds || 0), 0);
  const singers = new Set(q.map((e) => (e.singer || '').toLowerCase()).filter(Boolean)).size;
  const stats = $('idleStats');
  stats.textContent = '';
  if (q.length) {
    const mk = (b, t) => { const sp = document.createElement('span'); const bb = document.createElement('b'); bb.textContent = b; sp.append(bb, ` ${t}`); return sp; };
    stats.append(mk(String(q.length), q.length === 1 ? 'låt i kön' : 'låtar i kön'), mk(`~${Math.max(1, Math.round(totalSec / 60))}`, 'min'), mk(String(singers), singers === 1 ? 'sångare' : 'sångare'));
  }
  const hist = $('idleHistory');
  hist.textContent = '';
  const h = (snapshot.history || []).slice(0, 3);
  if (h.length) {
    hist.append('Senast: ');
    h.forEach((x, i) => { const b = document.createElement('b'); b.textContent = `${x.singer || 'Okänd'} – ${x.title}`; hist.append(b, i < h.length - 1 ? ' · ' : ''); });
  }
  const ul = $('idleQueue');
  ul.textContent = '';
  q.slice(0, 5).forEach((e, i) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = `${i + 1}. ${e.singer || 'Okänd'}`;
    li.append(b, ` – ${e.title}${e.artist ? ` (${e.artist})` : ''}${e.ready ? '' : ' ⏳'}`);
    ul.appendChild(li);
  });
  const hint = document.createElement('li');
  hint.className = 'hint';
  if (!q.length) hint.textContent = 'Kön är tom – välj en låt i mobilen! 🎶';
  else if (!settings.autoPlay) hint.textContent = '▶ Tryck "Starta nästa" i mobilen';
  else if (!q.some((e) => e.ready)) hint.textContent = '⏳ Laddar ner nästa låt…';
  else hint.textContent = '';
  if (hint.textContent) ul.appendChild(hint);
}

const TIPS = ['🔥 Tryck på emojis i mobilen för att peppa sångaren!', '🎤 Skriv ditt namn så hamnar det på TV:n', '🇸🇪 Prova en svensk klassiker under Sök låt',
  '📁 Har du en egen MP3? Ladda upp den direkt från mobilen', '🎼 För högt? Sänk tonarten under ⚙️ Avancerat', '🕺 Dansband & Schlager finns som snabbfilter',
  '⏪ Kommer texten fel? Använd Snabb text-synk', '🗳️ Rösta för att hoppa över en låt'];
let tipIdx = 0;
setInterval(() => {
  if (!document.body.classList.contains('is-idle')) return;
  const el = $('idleTip');
  el.classList.add('fade');
  setTimeout(() => { el.textContent = TIPS[tipIdx++ % TIPS.length]; el.classList.remove('fade'); }, 600);
}, 9000);
$('idleTip').textContent = TIPS[tipIdx++];

function showIdle(on) {
  document.body.classList.toggle('is-idle', on);
  $('idle').classList.toggle('hidden', !on);
  if (on) {
    $('lyrics').classList.add('off');
    $('nowCard').classList.add('hidden');
    videoEl.classList.remove('on', 'dimmed');
    document.body.classList.remove('video-full');
    setCoverBackground(null);
    $('progressBar').style.transform = 'scaleX(0)';
  }
}

// ───────────────────────────── Uppspelning ─────────────────────────────
function applyMode() {
  const s = current.song;
  const hasLyrics = lyr.lines.length > 0;
  clearTimeout(videoFullTimer);
  document.body.classList.remove('video-full', 'video-lyrics');
  videoEl.classList.remove('on', 'dimmed');
  if (s.type === 'video' && !hasLyrics) {
    current.mode = 'video-full';
    videoEl.classList.add('on');
    videoFullTimer = setTimeout(() => document.body.classList.add('video-full'), 8000);
  } else if (s.type === 'video' && settings.theme === 'video') {
    current.mode = 'lyrics';
    videoEl.classList.add('on', 'dimmed');
    document.body.classList.add('video-lyrics');
  } else current.mode = hasLyrics ? 'lyrics' : 'none';
  $('lyrics').classList.toggle('off', current.mode !== 'lyrics');
  if (current.mode === 'none') { // ljud utan text
    $('lyrics').classList.remove('off');
    $('lCur').textContent = 'Ingen synkad text för den här låten';
    $('lPrev').textContent = ''; $('lNext').textContent = 'Ändra text via ⚙️ Avancerat i mobilen'; $('lNext2').textContent = '';
  }
}

function stopMedia() {
  for (const el of [audioEl, videoEl]) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
}

function waitEvent(el, ev, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(tm); el.removeEventListener(ev, done); resolve(); };
    const tm = setTimeout(done, ms);
    el.addEventListener(ev, done, { once: true });
  });
}

async function showIntro(singer, song, seconds, token) {
  introActive = true;
  $('introSinger').textContent = singer || 'Nästa sångare';
  $('introSong').textContent = song.title;
  $('introArtist').textContent = song.artist;
  setCover($('introCover'), $('introPh'), song.cover, song.artist, song.title);
  $('intro').classList.remove('hidden');
  const box = $('intro').querySelector('.box');
  box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
  for (let i = seconds; i > 0; i--) {
    if (token !== loadToken) return;
    $('introCount').textContent = String(i);
    await new Promise((r) => setTimeout(r, 1000));
  }
  $('intro').classList.add('hidden');
  introActive = false;
}

async function playMedia() {
  const ok = await engine.resume();
  if (!ok) { $('unlock').classList.remove('hidden'); return; }
  try { await media.play(); }
  catch (e) {
    if (e.name === 'NotAllowedError') $('unlock').classList.remove('hidden');
    else if (e.name !== 'AbortError') socket.emit('tv:error', { message: e.message });
  }
}

async function loadSong(p) {
  const token = ++loadToken;
  clearCelebration();
  stopMedia();
  showIdle(false);
  current = { song: p.song, singer: p.singer, qid: p.qid, mode: 'lyrics' };
  liveOffsetMs = p.offsetMs || 0;
  media = p.song.type === 'video' ? videoEl : audioEl;
  media.src = p.song.url;
  media.preservesPitch = true;
  media.playbackRate = settings.speed || 1;
  media.load();
  prepareLyrics(p.song.lrc);
  applyMode();
  setCoverBackground(p.song.cover);
  setCover($('nowCover'), $('nowPh'), p.song.cover, p.song.artist, p.song.title);
  engine.songGainDb = p.song.gainDb || 0;
  engine.applyGain();
  applause = { '🔥': 0, '👏': 0, '❤️': 0, '🎉': 0, '🍺': 0, '😂': 0 };
  lastTimeText = '';
  $('nowTitle').textContent = p.song.title;
  $('nowArtist').textContent = p.song.artist;
  $('nowSinger').textContent = p.singer ? `🎤 ${p.singer}` : '';
  $('nowCard').classList.remove('hidden');
  renderQueueInfo();
  if (p.intro && p.introSeconds > 0) await showIntro(p.singer, p.song, p.introSeconds, token);
  else { $('intro').classList.add('hidden'); introActive = false; }
  if (token !== loadToken) return;
  if (media.readyState < 1) await waitEvent(media, 'loadedmetadata', 15000);
  if (token !== loadToken) return;
  if (p.resumeAt > 0 && Number.isFinite(media.duration)) media.currentTime = Math.min(p.resumeAt, media.duration - 1);
  await playMedia();
}

for (const el of [audioEl, videoEl]) {
  el.addEventListener('ended', () => { if (el === media && current) onEnded(); });
  el.addEventListener('error', () => {
    if (el !== media || !current || !el.getAttribute('src')) return;
    socket.emit('tv:error', { message: el.error?.message || `mediafel ${el.error?.code || ''}` });
  });
}

function onEnded() {
  socket.emit('tv:ended');
  celebrate(current?.singer);
}

// ───────────────────────────── Firande & reaktioner ─────────────────────────────
let celebrateTimer = null;
function hideReady() { readyShown = false; $('readyBanner').classList.add('hidden'); document.body.classList.remove('ready-on'); }
function clearCelebration() {
  hideReady();
  clearTimeout(celebrateTimer);
  celebrating = false;
  document.body.classList.remove('celebrating');
  $('celebrate').classList.add('hidden');
  $('celebrate').textContent = '';
}

function celebrate(singer) {
  celebrating = true;
  hideReady();
  document.body.classList.add('celebrating');
  const el = $('celebrate');
  el.textContent = '';
  el.classList.remove('hidden');
  const cs = getComputedStyle(document.body);
  const colors = ['--accent', '--accent2', '--fill', '--fill2'].map((v) => cs.getPropertyValue(v).trim()).concat(['#ffffff', '#ffe066']);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    const st = c.style;
    st.setProperty('--c', colors[i % colors.length]);
    st.setProperty('--dx', `${(Math.random() * 90 - 45).toFixed(1)}vw`);
    st.setProperty('--dy', `${(-20 - Math.random() * 40).toFixed(1)}vh`);
    st.setProperty('--rot', `${Math.round(Math.random() * 1440 - 720)}deg`);
    st.setProperty('--dur', `${(2.6 + Math.random() * 1.4).toFixed(2)}s`);
    st.setProperty('--delay', `${(Math.random() * 0.25).toFixed(2)}s`);
    st.setProperty('--w', `${(0.5 + Math.random() * 0.5).toFixed(2)}vw`);
    st.setProperty('--h', `${(0.9 + Math.random() * 0.8).toFixed(2)}vw`);
    frag.appendChild(c);
  }
  const msgs = ['Snyggt sjunget!', 'Vilken röst!', 'Bravo!', 'Fantastiskt!', 'Superstjärna!'];
  const msg = document.createElement('div');
  msg.className = 'msg';
  const big = document.createElement('div');
  big.className = 'big';
  big.textContent = msgs[Math.floor(Math.random() * msgs.length)];
  const clap = document.createElement('div');
  clap.className = 'emoji';
  clap.textContent = '👏🎤👏';
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = singer ? `Applåder för ${singer}! 🎉` : 'Applåder! 🎉';
  msg.append(clap, big, sub);
  const counts = Object.entries(applause).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((a, [, n]) => a + n, 0);
  if (total) {
    const meter = document.createElement('div');
    meter.className = 'meter';
    for (const [e, n] of counts.slice(0, 4)) { const sp = document.createElement('span'); sp.textContent = `${e} ${n}`; meter.appendChild(sp); }
    const award = document.createElement('div');
    award.className = 'award';
    award.textContent = total >= 30 ? '🏆 Publikens favorit!' : total >= 10 ? '🔥 Publiken älskade det!' : '👍 Publiken gillade det!';
    msg.append(meter, award);
  }
  frag.appendChild(msg);
  el.appendChild(frag);
  engine.fanfare();
  for (let i = 0; i < 12; i++) setTimeout(() => spawnReaction(['👏', '🎉', '❤️', '🔥'][i % 4], { fullWidth: true }), i * 120);
  celebrateTimer = setTimeout(() => {
    clearCelebration();
    socket.emit('tv:celebrated');
    if (!current || (current && media.ended)) { current = null; stopMedia(); showIdle(true); renderQueueInfo(); }
  }, 4800);
}

let applause = {};
function spawnReaction(emoji, { fullWidth = false } = {}) {
  const layer = $('reactions');
  if (layer.childElementCount > 40) return;
  const s = document.createElement('span');
  s.className = 'reaction';
  s.textContent = emoji;
  // Sidofält (2–15 % / 85–96 %) så att texten i mitten förblir läsbar
  const lane = Math.random() < 0.5 ? 2 + Math.random() * 13 : 85 + Math.random() * 11;
  s.style.setProperty('--x', `${(fullWidth ? 4 + Math.random() * 88 : lane).toFixed(1)}%`);
  s.style.setProperty('--size', `${(3.2 + Math.random() * 2.8).toFixed(1)}vw`);
  s.style.setProperty('--dur', `${(3.4 + Math.random() * 2).toFixed(2)}s`);
  s.style.setProperty('--sway', `${(Math.random() * 12 - 6).toFixed(1)}vw`);
  s.addEventListener('animationend', () => s.remove(), { once: true });
  layer.appendChild(s);
}

// ───────────────────────────── Huvudloop ─────────────────────────────
// Texttid = mediatid korrigerad för automatisk synk (tempo/förskjutning), manuell justering och ljudfördröjning.
// Ljudet hörs `latens` sekunder efter att mediet passerat en punkt → visa texten för det som hörs just nu.
function lyricTime(ct) {
  let t = ct;
  const sy = current?.song?.sync;
  if (settings.autoSync !== false && sy && sy.applied) t = (t - sy.shiftSec) / sy.scale;
  t += liveOffsetMs / 1000;
  t -= (settings.avLatencyMs || 0) / 1000;
  if (settings.autoLatency !== false) t -= engine.latency();
  return t;
}

let lastTimeText = '';
let readyShown = false;
function frame() {
  if (calib.on) drawCalib();
  requestAnimationFrame(frame);
  if (current && !introActive) {
    const d = media.duration;
    const ct = media.currentTime;
    if (Number.isFinite(d) && d > 0) $('progressBar').style.transform = `scaleX(${(ct / d).toFixed(4)})`;
    if (current.mode === 'lyrics' && lyr.lines.length) {
      const t = lyricTime(ct);
      const idx = findLineIdx(t);
      if (idx !== lyr.idx) renderLines(idx, t);
      else updateWords(t);
      updateBreak(t);
    }
    const remaining = Number.isFinite(d) ? d - ct : 999;
    if (remaining < 999) {
      const r = Math.max(0, Math.ceil(remaining));
      const txt = `−${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
      if (txt !== lastTimeText) { lastTimeText = txt; $('nowTime').textContent = txt; }
    }
    $('nextChip').classList.toggle('soon', remaining < 20 && !$('nextChip').classList.contains('hidden'));
    // Stor namnskylt de sista 20 sekunderna så att nästa sångare hinner fram
    const next = snapshot?.queue?.[0];
    const showReady = !!next && remaining < 20 && remaining > 0.5 && !celebrating;
    if (showReady !== readyShown) {
      readyShown = showReady;
      $('readyBanner').classList.toggle('hidden', !showReady);
      document.body.classList.toggle('ready-on', showReady);
      if (showReady) {
        $('readyName').textContent = next.singer || 'Nästa sångare';
        $('readySong').textContent = `${next.title}${next.artist ? ` – ${next.artist}` : ''}`;
      }
    }
  }
  drawViz();
}

setInterval(() => {
  if (!current) return;
  socket.emit('tv:state', {
    phase: introActive ? 'intro' : media.paused ? 'paused' : 'playing',
    t: media.currentTime || 0, d: Number.isFinite(media.duration) ? media.duration : 0, paused: media.paused,
    lat: settings.autoLatency !== false ? Math.round(engine.latency() * 1000) / 1000 : 0,
  });
}, 1000);

// ───────────────────────────── Socket ─────────────────────────────
socket.on('connect', () => { socket.emit('hello', { role: 'tv' }); showStatus(''); });
socket.on('disconnect', () => showStatus('⚠ Tappade anslutningen till servern – försöker igen…'));

socket.on('state', (s) => {
  snapshot = s;
  applySettings(s.settings);
  liveOffsetMs = s.liveOffsetMs ?? liveOffsetMs;
  updateQr(s.remoteUrl);
  updateWifi(s.wifi, settings.wifiQrVisible !== false);
  if (!s.now && current && !celebrating && !introActive) { current = null; stopMedia(); }
  if (!current && !celebrating) showIdle(true);
  renderQueueInfo();
});
socket.on('settings', applySettings);
socket.on('tv:gain', ({ gainDb }) => { engine.songGainDb = gainDb || 0; engine.applyGain(); });
socket.on('tv:sync', ({ sync }) => { if (current) { current.song.sync = sync; lyr.idx = -2; } });

// ───────────────────────────── Kalibrering av ljudfördröjning ─────────────────────────────
// Ett klick per sekund i högtalarna + en blixt på skärmen. Blixten visas när klicket HÖRS enligt nuvarande
// inställningar (webbläsarlatens + TV/högtalar-fördröjning). Justera i värdpanelen tills de sammanfaller.
const calib = { on: false, clicks: [], next: 0, out: null };
socket.on('tv:calib', ({ on }) => {
  calib.on = !!on;
  $('calib').classList.toggle('hidden', !calib.on);
  calib.clicks = [];
  if (calib.on && engine.ctx) {
    engine.resume();
    calib.next = engine.ctx.currentTime + 0.5;
    calib.out = engine.ctx.createGain();
    calib.out.gain.value = settings.muted ? 0 : Math.pow(settings.volume ?? 0.85, 2);
    calib.out.connect(engine.ctx.destination);
  } else if (calib.out) { calib.out.disconnect(); calib.out = null; }
});
function drawCalib() {
  const c = engine.ctx;
  if (!c || !calib.out) return;
  while (calib.next < c.currentTime + 0.3) { // schemalägg klick i förväg
    const o = c.createOscillator(); const g = c.createGain();
    o.frequency.value = 1500;
    g.gain.setValueAtTime(0.9, calib.next); g.gain.exponentialRampToValueAtTime(0.001, calib.next + 0.04);
    o.connect(g).connect(calib.out); o.start(calib.next); o.stop(calib.next + 0.05);
    calib.clicks.push(calib.next);
    calib.next += 1;
  }
  const lat = (settings.autoLatency !== false ? engine.latency() : 0) + (settings.avLatencyMs || 0) / 1000;
  const heard = c.currentTime - lat;
  calib.clicks = calib.clicks.filter((k) => k > heard - 1);
  const flash = calib.clicks.some((k) => heard >= k && heard < k + 0.09);
  $('calibDot').classList.toggle('on', flash);
  $('calibVal').textContent = `${settings.avLatencyMs || 0} ms${settings.autoLatency !== false ? ` + auto ${Math.round(engine.latency() * 1000)} ms` : ''}`;
}
setInterval(() => { if (socket.connected) socket.emit('tv:beat'); }, 5000);
socket.on('offset', ({ liveOffsetMs: v }) => { liveOffsetMs = v; lyr.idx = -2; });
socket.on('tv:load', (p) => { if (p?.song) loadSong(p); });
socket.on('tv:stop', () => {
  loadToken++;
  introActive = false;
  $('intro').classList.add('hidden');
  if (celebrating) { current = null; return; } // idle visas när firandet är klart
  current = null;
  stopMedia();
  showIdle(true);
  renderQueueInfo();
});
socket.on('tv:lyrics', ({ lrc }) => {
  if (!current) return;
  current.song.lrc = lrc;
  prepareLyrics(lrc);
  applyMode();
});
socket.on('tv:cmd', async ({ cmd, value }) => {
  if (!current || introActive) return;
  if (cmd === 'toggle') { if (media.paused) await playMedia(); else media.pause(); }
  else if (cmd === 'play') await playMedia();
  else if (cmd === 'pause') media.pause();
  else if (cmd === 'restart') { media.currentTime = 0; lyr.idx = -2; await playMedia(); }
  else if (cmd === 'seek') { media.currentTime = value; lyr.idx = -2; }
});
socket.on('reaction', ({ emoji }) => {
  if (settings.reactionsEnabled === false) return;
  if (current && emoji in applause) applause[emoji]++;
  spawnReaction(emoji);
});
socket.on('toast', ({ type, msg }) => { if (type === 'error') toast(msg); });

$('unlock').addEventListener('click', async () => {
  $('unlock').classList.add('hidden');
  await engine.resume();
  if (current) await playMedia();
});

// Dölj muspekaren helt i kiosk-läge, men visa vid rörelse (felsökning)
let mouseTimer = null;
document.addEventListener('mousemove', () => {
  document.body.style.cursor = 'default';
  clearTimeout(mouseTimer);
  mouseTimer = setTimeout(() => { document.body.style.cursor = 'none'; }, 2000);
});

// Ljudgrafen måste finnas innan första tv:load – anslut först därefter.
try { await engine.init(); } catch (e) { console.error('Ljudmotorn kunde inte starta', e); }
await engine.resume(); // Utan --autoplay-policy-flaggan visas klick-overlay vid första uppspelning
socket.connect();
requestAnimationFrame(frame);
