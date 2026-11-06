// Delad LRC-/VTT-parser. Importeras både av servern (Node ESM) och TV-vyn (browser ESM).
// Stöd: standard-LRC, flera tidsstämplar per rad, Enhanced LRC (<mm:ss.xx> per ord), [offset:±ms].

const TS_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TS_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META_RE = /^\[([a-z#]+):(.*)\]$/i;
// Duett-markeringar i början av en rad: "M:", "F:", "D:", "v1:", "Alla:" … Rösten gäller tills den byts.
const VOICE_RE = /^(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)?\s*(v1|v2|v3|m|f|d|man|kvinna|alla|båda|both|all|duet)\s*:\s+/i;
const VOICE_MAP = { v1: 1, m: 1, man: 1, v2: 2, f: 2, kvinna: 2, v3: 3, d: 'all', alla: 'all', båda: 'all', both: 'all', all: 'all', duet: 'all' };

function toSec(m, s, frac) {
  let f = 0;
  if (frac) f = Number(frac) / Math.pow(10, frac.length);
  return Number(m) * 60 + Number(s) + f;
}

function parseWords(text, lineStart) {
  // Returnerar { plain, words|null }. words = [{ t, text }]
  if (!WORD_TS_RE.test(text)) { WORD_TS_RE.lastIndex = 0; return { plain: text.trim(), words: null }; }
  WORD_TS_RE.lastIndex = 0;
  const words = [];
  let lastT = lineStart;
  let lastIdx = 0;
  let m;
  const pending = [];
  while ((m = WORD_TS_RE.exec(text)) !== null) {
    const chunk = text.slice(lastIdx, m.index);
    if (chunk) pending.push({ t: lastT, text: chunk });
    lastT = toSec(m[1], m[2], m[3]);
    lastIdx = m.index + m[0].length;
  }
  const tail = text.slice(lastIdx);
  if (tail) pending.push({ t: lastT, text: tail });
  // Slå ihop till ord (chunk kan innehålla flera ord om bara en tidsstämpel finns)
  for (const p of pending) {
    const parts = p.text.split(/(\s+)/).filter((x) => x.length);
    let first = true;
    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        if (words.length) words[words.length - 1].text += ' ';
        continue;
      }
      words.push({ t: p.t, text: part, inherit: !first });
      first = false;
    }
  }
  const plain = words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
  if (words.length) words[words.length - 1].text = words[words.length - 1].text.trimEnd();
  return { plain, words: words.length ? words : null };
}

export function parseLrc(input) {
  const out = { lines: [], meta: {}, hasWordTimes: false, hasVoices: false };
  if (!input || typeof input !== 'string') return out;
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let offsetSec = 0;
  let voice = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    TS_RE.lastIndex = 0;
    const stamps = [];
    let m;
    let rest = line;
    // Tidsstämplar i början av raden
    while ((m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest)) !== null) {
      stamps.push(toSec(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) {
      const meta = META_RE.exec(line);
      if (meta) {
        const key = meta[1].toLowerCase();
        out.meta[key] = meta[2].trim();
        if (key === 'offset') {
          const v = parseInt(meta[2], 10);
          if (Number.isFinite(v)) offsetSec = v / 1000;
        }
      }
      continue;
    }
    const vm = VOICE_RE.exec(rest);
    if (vm) {
      voice = VOICE_MAP[vm[2].toLowerCase()] ?? null;
      out.hasVoices = true;
      rest = (vm[1] || '') + rest.slice(vm[0].length);
    }
    for (const t of stamps) {
      const { plain, words } = parseWords(rest, t);
      if (words) out.hasWordTimes = true;
      out.lines.push({ t, text: plain, voice: plain ? voice : null, words: words ? words.map((w) => ({ t: w.t, text: w.text })) : null });
    }
  }
  // LRC-standard: positivt offset => texten visas tidigare
  if (offsetSec) {
    for (const l of out.lines) {
      l.t = Math.max(0, l.t - offsetSec);
      if (l.words) for (const w of l.words) w.t = Math.max(0, w.t - offsetSec);
    }
  }
  out.lines.sort((a, b) => a.t - b.t);
  return out;
}

export function isSyncedLrc(text) {
  if (!text) return false;
  const p = parseLrc(text);
  return p.lines.filter((l) => l.text).length >= 3;
}

export function formatTs(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
}

function vttTime(str) {
  const p = str.trim().split(':');
  let h = 0, m = 0, s = 0;
  if (p.length === 3) { h = +p[0]; m = +p[1]; s = parseFloat(p[2].replace(',', '.')); }
  else { m = +p[0]; s = parseFloat(p[1].replace(',', '.')); }
  return h * 3600 + m * 60 + s;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// Konverterar WebVTT (manuella eller auto-genererade YouTube-undertexter) till LRC.
export function vttToLrc(vtt) {
  if (!vtt) return '';
  const text = vtt.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const isAuto = /<c>|<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(text);
  // Radbaserad parsning: tomma/blanka rader inne i cues (förekommer i YouTube-auto-VTT) bryter inget.
  const all = text.split('\n');
  const cues = [];
  let cur = null;
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    if (l.includes('-->')) {
      const [startStr, endRest] = l.split('-->');
      cur = { start: vttTime(startStr), end: vttTime(endRest.trim().split(/\s+/)[0]), body: [] };
      cues.push(cur);
      continue;
    }
    if (!cur) continue;
    const next = all[i + 1] || '';
    if (l.trim() && next.includes('-->') && !all[i - 1]?.trim()) continue; // cue-identifierare
    cur.body.push(l);
  }
  const out = [];
  let prev = '';
  for (const c of cues) {
    const { start, end } = c;
    const body = c.body
      .map((l) => decodeEntities(l.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!body.length) continue;
    let content;
    if (isAuto) {
      if (end - start < 0.05) continue; // "stillastående" 10 ms-cues
      content = body[body.length - 1];
    } else {
      content = body.join(' ');
    }
    if (/^\[(musik|music|applåder|applause)\]$/i.test(content) || /^[♪♫\s]+$/.test(content)) content = '';
    if (content === prev) continue;
    prev = content;
    out.push(`[${formatTs(start)}]${content}`);
  }
  return out.join('\n');
}
