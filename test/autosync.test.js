import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { analyzeSync } from '../lib/autosync.js';

let hasFfmpeg = true;
try { execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

// Konstgjord "låt": brus i stereo (bred mix) + "sång" i mitten som börjar exakt där raderna ska vara
function makeSong(file, lineTimes, { tempo, shift, dur = 70 }) {
  const sr = 22050; const n = sr * dur;
  const data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28);
  data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  const starts = lineTimes.map((t) => tempo * t + shift);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let voice = 0;
    for (let k = 0; k < starts.length; k++) {
      const s0 = starts[k]; const s1 = Math.min(s0 + 1.8, (starts[k + 1] ?? Infinity) - 0.4);
      if (t >= s0 && t < s1) { const env = Math.min(1, (t - s0) / 0.02); voice = env * 0.35 * (Math.sin(2 * Math.PI * 440 * t) + 0.5 * Math.sin(2 * Math.PI * 880 * t)); break; }
    }
    const l = voice + 0.12 * rnd(); const r = voice + 0.12 * rnd();
    data.writeInt16LE(Math.max(-32767, Math.min(32767, l * 32767)), 44 + i * 4);
    data.writeInt16LE(Math.max(-32767, Math.min(32767, r * 32767)), 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
const LINES = [3.1, 6.4, 9.2, 13.8, 16.1, 19.9, 22.4, 26.7, 29.3, 33.5, 36.2, 40.8, 43.1, 47.6, 50.4, 54.0, 57.7, 60.2];
const lrc = LINES.map((t, i) => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}]Rad ${i + 1}`).join('\n');

test('hittar förskjutning (längre intro)', { skip: !hasFfmpeg }, async () => {
  const f = `/tmp/autosync-a-${process.pid}.wav`;
  makeSong(f, LINES, { tempo: 1, shift: 2.35 });
  const r = await analyzeSync(f, lrc);
  assert.equal(r.confidence, 'high'); assert.equal(r.applied, true);
  assert.ok(Math.abs(r.shiftSec - 2.35) <= 0.04, `shift ${r.shiftSec}`);
  assert.ok(Math.abs(r.scale - 1) <= 0.002, `scale ${r.scale}`);
});

test('hittar tempo + förskjutning (glidning)', { skip: !hasFfmpeg }, async () => {
  const f = `/tmp/autosync-b-${process.pid}.wav`;
  makeSong(f, LINES, { tempo: 1.016, shift: -1.2 });
  const r = await analyzeSync(f, lrc);
  assert.equal(r.applied, true);
  assert.ok(Math.abs(r.scale - 1.016) <= 0.003, `scale ${r.scale}`);
  assert.ok(Math.abs(r.shiftSec + 1.2) <= 0.1, `shift ${r.shiftSec}`);
});

test('rätt synk från början → ändras inte', { skip: !hasFfmpeg }, async () => {
  const f = `/tmp/autosync-c-${process.pid}.wav`;
  makeSong(f, LINES, { tempo: 1, shift: 0 });
  const r = await analyzeSync(f, lrc);
  assert.equal(r.nearIdentity, true); assert.equal(r.applied, false);
});

test('ingen sång → låg säkerhet, ändras inte', { skip: !hasFfmpeg }, async () => {
  const f = `/tmp/autosync-d-${process.pid}.wav`;
  makeSong(f, [], { tempo: 1, shift: 0 });
  const r = await analyzeSync(f, lrc);
  assert.equal(r.applied, false); assert.notEqual(r.confidence, 'high');
});
