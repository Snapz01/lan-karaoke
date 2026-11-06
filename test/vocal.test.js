import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(fs.readFileSync(new URL('../public/vocal-worklet.js', import.meta.url), 'utf8'));
const DSP = globalThis.VocalReducerDSP;
const SR = 48000;

// Energi i ett smalt frekvensband via Goertzel
function bandEnergy(x, f) {
  const k = 2 * Math.cos((2 * Math.PI * f) / SR); let s1 = 0; let s2 = 0;
  for (let i = 0; i < x.length; i++) { const s = x[i] + k * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}
const db = (a, b) => 10 * Math.log10(a / b);

function run(L, R, amount) {
  const dsp = new DSP(SR);
  const oL = new Float32Array(L.length); const oR = new Float32Array(L.length);
  for (let i = 0; i < L.length; i += 128) dsp.process(L.subarray(i, i + 128), R.subarray(i, i + 128), oL.subarray(i, i + 128), oR.subarray(i, i + 128), amount);
  return { oL, oR, dsp };
}

// "Låt": sång i mitten (700 Hz), bas i mitten (80 Hz), gitarr hårt vänster (1500 Hz), synt höger (2300 Hz)
function song(seconds = 3, mono = false) {
  const n = SR * seconds; const L = new Float32Array(n); const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vocal = 0.3 * Math.sin(2 * Math.PI * 700 * t); const bass = 0.3 * Math.sin(2 * Math.PI * 80 * t);
    const gtr = 0.2 * Math.sin(2 * Math.PI * 1500 * t); const syn = 0.2 * Math.sin(2 * Math.PI * 2300 * t);
    L[i] = vocal + bass + gtr + (mono ? syn : 0.1 * syn);
    R[i] = vocal + bass + (mono ? gtr : 0.1 * gtr) + syn;
  }
  return { L, R };
}
const tail = (x) => x.subarray(x.length / 2); // mät efter insvängning

test('Av: sången i mitten dämpas kraftigt, bas och sidoinstrument blir kvar', () => {
  const { L, R } = song();
  const { oL, oR } = run(L, R, 1);
  const vocalDrop = db(bandEnergy(tail(oL), 700) + bandEnergy(tail(oR), 700), bandEnergy(tail(L), 700) + bandEnergy(tail(R), 700));
  const bassDiff = db(bandEnergy(tail(oL), 80), bandEnergy(tail(L), 80));
  const gtrDiff = db(bandEnergy(tail(oL), 1500), bandEnergy(tail(L), 1500));
  assert.ok(vocalDrop < -15, `sång ${vocalDrop.toFixed(1)} dB`);
  assert.ok(Math.abs(bassDiff) < 1.5, `bas ${bassDiff.toFixed(1)} dB`);
  assert.ok(gtrDiff > -3 && gtrDiff < 7, `gitarr ${gtrDiff.toFixed(1)} dB`);
});

test('Svag: sången sänks mindre än vid Av', () => {
  const { L, R } = song();
  const svag = db(bandEnergy(tail(run(L, R, 0.6).oL), 700), bandEnergy(tail(L), 700));
  const av = db(bandEnergy(tail(run(L, R, 1).oL), 700), bandEnergy(tail(L), 700));
  assert.ok(svag < -3 && svag > av, `svag ${svag.toFixed(1)} / av ${av.toFixed(1)}`);
});

test('Full (0): signalen passerar oförändrad (bortsett från 2048 sampels fördröjning)', () => {
  const { L, R } = song(1);
  const { oL } = run(L, R, 0);
  let err = 0; let ref = 0;
  for (let i = 8192; i < L.length; i++) { err += (oL[i] - L[i - 2048]) ** 2; ref += L[i - 2048] ** 2; }
  assert.ok(db(err, ref) < -40, `fel ${db(err, ref).toFixed(1)} dB`);
});

test('Mono-låt känns igen och tystas INTE', () => {
  const { L, R } = song(3, true);
  const { oL, dsp } = run(L, R, 1);
  assert.equal(dsp.isMono, true);
  const total = db(tail(oL).reduce((a, v) => a + v * v, 0), tail(L).reduce((a, v) => a + v * v, 0));
  assert.ok(total > -2, `nivå ${total.toFixed(1)} dB`);
});
