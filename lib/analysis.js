// Ljudanalys med ffmpeg i ett pass: EBU R128-loudness (normalisering) + inledande tystnad (synkförslag).
// Körs en gång per låt i bakgrunden med låg prioritet (nice 15), max en åt gången.
import { spawn } from 'node:child_process';
import { FFMPEG_BIN, TARGET_LUFS } from './config.js';
import { clamp } from './util.js';

export function parseAnalysis(stderr) {
  const out = { lufs: null, truePeak: null, leadSilence: 0 };
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      out.lufs = Number(j.input_i);
      out.truePeak = Number(j.input_tp);
    } catch { /* ignoreras */ }
  }
  const s = /silence_start:\s*(-?[\d.]+)/.exec(stderr);
  const e = /silence_end:\s*([\d.]+)/.exec(stderr);
  if (s && e && Number(s[1]) < 0.15) out.leadSilence = Number(e[1]);
  return out;
}

export function gainFor({ lufs, truePeak }) {
  if (!Number.isFinite(lufs) || lufs < -70) return 0; // tyst/okänd fil
  let g = TARGET_LUFS - lufs;
  if (Number.isFinite(truePeak) && g > 0) g = Math.min(g, -0.5 - truePeak); // höj inte över 0 dBTP
  return Math.round(clamp(g, -15, 12) * 10) / 10;
}

// Synkförslag: YouTube-versionen är längre än LRCLIB-versionen och börjar med tystnad → texten ska komma senare.
export function suggestOffsetMs({ mediaDuration, lyricsDuration, leadSilence }) {
  if (!mediaDuration || !lyricsDuration) return 0;
  const extra = mediaDuration - lyricsDuration;
  if (extra < 1.5 || leadSilence < 0.8) return 0;
  const shift = Math.min(extra, leadSilence);
  return -Math.round((shift * 1000) / 50) * 50;
}

function runFfmpeg(file, timeoutMs) {
  const args = ['-hide_banner', '-nostats', '-i', file, '-vn', '-sn', '-dn',
    '-af', `silencedetect=noise=-45dB:d=0.4,loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'];
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('nice', ['-n', '15', FFMPEG_BIN, ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { child = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-200000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg ${code}: ${stderr.split('\n').slice(-3).join(' ')}`)); });
  });
}

const queue = [];
let busy = false;

export function analyzeFile(file) {
  return new Promise((resolve, reject) => {
    queue.push({ file, resolve, reject });
    pump();
  });
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const { file, resolve, reject } = queue.shift();
  try { resolve(parseAnalysis(await runFfmpeg(file, 5 * 60 * 1000))); }
  catch (e) { reject(e); }
  finally { busy = false; pump(); }
}

export const analysisQueueLength = () => queue.length + (busy ? 1 : 0);
