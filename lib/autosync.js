// Automatisk synk med röstanalys.
// 1) ffmpeg plockar ut mittkanalen (där sången ligger), bandpass 250–3000 Hz, 8 kHz mono → energikurva per 10 ms.
// 2) "Insatser" = energi de närmaste 150 ms jämfört med de föregående 250 ms (sång som börjar efter en paus).
// 3) Sök tempo (0,97–1,03) × förskjutning (±8 s) där LRC-radernas starter träffar flest insatser:
//      ljudtid = tempo × texttid + förskjutning
// 4) Säkerhet = hur mycket bästa kandidaten sticker ut (z-värde). Bara tydliga träffar används automatiskt.
import { spawn } from 'node:child_process';
import { FFMPEG_BIN } from './config.js';
import { parseLrc } from '../public/lrc.js';

const FRAME = 0.01; // 10 ms
const SR = 8000;
const HOP = SR * FRAME;

export function vocalEnvelope(file, timeoutMs = 3 * 60 * 1000) {
  const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-i', file, '-vn', '-sn', '-dn',
    '-af', 'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=250,lowpass=f=3000', '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn('nice', ['-n', '15', FFMPEG_BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').pop() || ''}`));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 2 / HOP);
      const env = new Float32Array(n);
      for (let f = 0; f < n; f++) {
        let sum = 0;
        for (let k = 0; k < HOP; k++) { const v = buf.readInt16LE((f * HOP + k) * 2) / 32768; sum += v * v; }
        env[f] = 10 * Math.log10(sum / HOP + 1e-9);
      }
      resolve(env);
    });
  });
}

// Insatsstyrka (dB-ökning) per bildruta + max i ett fönster [i+lo, i+hi] (förberäknat → O(1) per rad)
export function onsetCurve(env) {
  const n = env.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  const mean = (a, b) => { a = Math.max(0, a); b = Math.min(n, b); return b > a ? (pre[b] - pre[a]) / (b - a) : -90; };
  const on = new Float32Array(n);
  for (let i = 0; i < n; i++) on[i] = Math.max(0, mean(i, i + 15) - mean(i - 25, i - 2));
  return on;
}
function windowMax(on, lo, hi) {
  const n = on.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i + lo); j <= Math.min(n - 1, i + hi); j++) if (on[j] > m) m = on[j];
    out[i] = m;
  }
  return out;
}

const HIT_DB = 3; // en rad "träffar" om sången ökar minst 3 dB vid radstarten

export function align(env, lineTimes, { maxShift = 8 } = {}) {
  const on = onsetCurve(env);
  const wide = windowMax(on, -12, 20); // grovsök: −120…+200 ms tolerans
  const narrow = windowMax(on, -3, 6); // finsök: −30…+60 ms
  const n = on.length;
  const score = (arr, tempo, shift) => {
    let sum = 0;
    for (const t of lineTimes) {
      const f = Math.round((tempo * t + shift) / FRAME);
      if (f >= 0 && f < n) sum += arr[f];
    }
    return sum / lineTimes.length;
  };
  // 1) Grovsök över hela rymden – ger även fördelningen för säkerhetsmåttet
  let best = { score: -Infinity, tempo: 1, shift: 0 };
  let sum = 0; let sum2 = 0; let count = 0;
  for (let ti = 0; ti <= 30; ti++) {
    const tempo = 0.97 + ti * 0.002;
    for (let shift = -maxShift; shift <= maxShift + 1e-9; shift += 0.02) {
      const sc = score(wide, tempo, shift);
      sum += sc; sum2 += sc * sc; count++;
      if (sc > best.score) best = { score: sc, tempo, shift };
    }
  }
  const mean = sum / count;
  const std = Math.sqrt(Math.max(1e-9, sum2 / count - mean * mean));
  // 2) Finsök runt bästa grovträffen med smalt fönster; svag dragning mot tempo 1 vid lika poäng
  let fine = { score: -Infinity, tempo: best.tempo, shift: best.shift };
  for (let tempo = best.tempo - 0.004; tempo <= best.tempo + 0.004 + 1e-9; tempo += 0.0005) {
    for (let shift = best.shift - 0.3; shift <= best.shift + 0.3 + 1e-9; shift += 0.01) {
      const sc = score(narrow, tempo, shift) - 30 * Math.abs(tempo - 1);
      if (sc > fine.score) fine = { score: sc, tempo, shift };
    }
  }
  // Platå: flera förskjutningar ger samma poäng (fönstrets bredd) → ta mitten i stället för den tidigaste
  const plateau = [];
  for (let shift = fine.shift - 0.3; shift <= fine.shift + 0.3 + 1e-9; shift += 0.01) {
    if (score(narrow, fine.tempo, shift) - 30 * Math.abs(fine.tempo - 1) >= fine.score - 1e-6) plateau.push(shift);
  }
  if (plateau.length) fine.shift = plateau[Math.floor(plateau.length / 2)];
  let hits = 0;
  for (const t of lineTimes) {
    const f = Math.round((fine.tempo * t + fine.shift) / FRAME);
    if (f >= 0 && f < n && narrow[f] >= HIT_DB) hits++;
  }
  return {
    scale: Math.round(fine.tempo * 10000) / 10000,
    shiftSec: Math.round(fine.shift * 100) / 100,
    z: Math.round(((best.score - mean) / std) * 10) / 10,
    gainOverIdentity: Math.round(((best.score - score(wide, 1, 0)) / std) * 10) / 10,
    hitRate: Math.round((hits / lineTimes.length) * 100) / 100,
    strengthDb: Math.round(score(narrow, fine.tempo, fine.shift) * 10) / 10,
  };
}

// Hela kedjan för en låt. Returnerar { scale, shiftSec, z, confidence: 'high'|'medium'|'low', applied }
export async function analyzeSync(file, lrc) {
  const lines = parseLrc(lrc).lines.filter((l) => l.text);
  if (lines.length < 6) return { confidence: 'low', applied: false, reason: 'för få rader' };
  const env = await vocalEnvelope(file);
  const r = align(env, lines.map((l) => l.t));
  const nearIdentity = Math.abs(r.shiftSec) < 0.15 && Math.abs(r.scale - 1) < 0.003;
  // Hög säkerhet kräver både att träffen sticker ut OCH att de flesta rader faktiskt börjar på en sånginsats
  const confidence = r.z >= 4 && r.hitRate >= 0.6 && r.strengthDb >= HIT_DB ? 'high'
    : r.z >= 3 && r.hitRate >= 0.4 ? 'medium' : 'low';
  return { ...r, confidence, applied: confidence === 'high' && !nearIdentity, nearIdentity, at: Date.now() };
}
