// Sångdämpning 2.0 – spektral mittkanalsborttagning (STFT, 2048 punkter, 75 % överlapp).
// Varför inte bara L−R? Det tar bort ALLT som ligger i mitten (sång, bas, trummor, solo) → låter som att volymen sänks,
// och på mono-inspelningar blir det helt tyst. Här tas bara det mittpanorerade bort, och bara i sångens frekvensområde
// (≈150 Hz–7 kHz), med nivåkompensation så att musiken inte "försvinner". Mono-låtar känns igen och lämnas orörda.

const N = 2048;
const HOP = 512;

class VocalReducerDSP {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.norm = 1 / 1.5; // Hann² vid 75 % överlapp summerar till 1,5
    // Bitreversering + vridfaktorer för radix-2-FFT
    this.rev = new Uint32Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(N / 2); this.sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / N); this.sin[i] = Math.sin((2 * Math.PI * i) / N); }
    // Frekvensvikt: full effekt 200 Hz–6 kHz, mjuka kanter ned till 120 Hz och upp till 8 kHz
    this.band = new Float32Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) {
      const f = (k * sampleRate) / N;
      let w = 0;
      if (f >= 200 && f <= 6000) w = 1;
      else if (f > 120 && f < 200) w = (f - 120) / 80;
      else if (f > 6000 && f < 8000) w = 1 - (f - 6000) / 2000;
      this.band[k] = w;
    }
    this.inL = new Float32Array(N); this.inR = new Float32Array(N);
    this.outL = new Float32Array(N + HOP); this.outR = new Float32Array(N + HOP);
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.fill = 0; // antal nya sampel sedan senaste analys
    this.readPos = 0;
    this.outQueueL = new Float32Array(HOP); this.outQueueR = new Float32Array(HOP);
    this.mononess = 0; // glidande medel av korrelation (1 = mono)
    this.makeup = 1; // nivåkompensation (sångbandet), uppdateras per ram
    this.isMono = false;
  }

  fft(re, im, inverse) {
    const { rev } = this;
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1; const step = N / size;
      for (let start = 0; start < N; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step]; const s = inverse ? this.sin[k * step] : -this.sin[k * step];
          const a = start + k; const b = a + half;
          const tr = re[b] * c - im[b] * s; const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // En analysram: båda kanalerna packas i en komplex FFT (L + iR)
  frame(amount) {
    const { re, im, win, inL, inR, band } = this;
    for (let i = 0; i < N; i++) { re[i] = inL[i] * win[i]; im[i] = inR[i] * win[i]; }
    this.fft(re, im, false);
    let eIn = 0; let eOut = 0; let cross = 0; let pow = 0;
    // Bin 0 och N/2 är reella för båda kanaler – lämna dem
    for (let k = 1; k < N / 2; k++) {
      const j = N - k;
      // Separera L och R ur den packade transformen
      const lr = (re[k] + re[j]) / 2; const li = (im[k] - im[j]) / 2;
      const rr = (im[k] + im[j]) / 2; const ri = (re[j] - re[k]) / 2;
      const pl = lr * lr + li * li; const pr = rr * rr + ri * ri;
      const dot = lr * rr + li * ri; // Re(L·conj(R))
      const w = band[k];
      cross += dot * w; pow += (pl + pr) * 0.5 * w;
      let nlr = lr; let nli = li; let nrr = rr; let nri = ri;
      const active = w > 0 && amount > 0 && !this.isMono;
      if (active) {
        // Likhet 1 = identiskt i båda kanaler (mittpanorerat), 0 = okorrelerat/brett
        const sim = (2 * dot) / (pl + pr + 1e-12);
        let m = (sim - 0.55) / 0.4; m = m < 0 ? 0 : m > 1 ? 1 : m; m *= m;
        const g = m * w * amount;
        const cr = (lr + rr) / 2; const ci = (li + ri) / 2; // mittkomponent
        nlr = lr - g * cr; nli = li - g * ci; nrr = rr - g * cr; nri = ri - g * ci;
      }
      eIn += (pl + pr) * w; eOut += (nlr * nlr + nli * nli + nrr * nrr + nri * nri) * w;
      if (active) { // nivåkompensation bara i sångbandet → bas och diskant påverkas inte
        const mg = 1 + (this.makeup - 1) * w;
        nlr *= mg; nli *= mg; nrr *= mg; nri *= mg;
      }
      // Packa tillbaka: Y = L' + i·R'  →  Y[k] = L'k + i R'k, Y[N−k] = conj(L'k) + i conj(R'k)
      re[k] = nlr - nri; im[k] = nli + nrr;
      re[j] = nlr + nri; im[j] = -nli + nrr;
    }
    // Monodetektering (glidande, ~1 s): korrelation nära 1 i hela sångbandet = monoinspelning
    if (pow > 1e-6) {
      const corr = cross / pow;
      this.mononess += (corr - this.mononess) * 0.03;
      if (!this.isMono && this.mononess > 0.97) this.isMono = true;
      else if (this.isMono && this.mononess < 0.93) this.isMono = false;
    }
    // Nivåkompensation: ersätt halva energiförlusten (max +6 dB), mjukt över ~0,5 s
    const target = amount > 0 && !this.isMono && eOut > 1e-9 && eIn > eOut ? Math.min(2, Math.pow(eIn / eOut, 0.25)) : 1;
    this.makeup += (target - this.makeup) * 0.08;
    this.fft(re, im, true);
    const sc = this.norm / N;
    for (let i = 0; i < N; i++) {
      this.outL[i] += re[i] * win[i] * sc;
      this.outR[i] += im[i] * win[i] * sc;
    }
  }

  // Processar ett block. Utgången är fördröjd N sampel (≈ 43 ms vid 48 kHz).
  process(inpL, inpR, outL, outR, amount) {
    const n = inpL.length;
    for (let i = 0; i < n; i++) {
      // Skjut in sampel i analysfönstret
      this.inL[N - HOP + this.fill] = inpL[i];
      this.inR[N - HOP + this.fill] = inpR[i];
      outL[i] = this.outQueueL[this.fill];
      outR[i] = this.outQueueR[this.fill];
      this.fill++;
      if (this.fill === HOP) {
        this.frame(amount);
        // Färdiga sampel för nästa hop + skifta buffertar
        this.outQueueL.set(this.outL.subarray(0, HOP));
        this.outQueueR.set(this.outR.subarray(0, HOP));
        this.outL.copyWithin(0, HOP); this.outR.copyWithin(0, HOP);
        this.outL.fill(0, N); this.outR.fill(0, N);
        this.inL.copyWithin(0, HOP); this.inR.copyWithin(0, HOP);
        this.fill = 0;
      }
    }
  }
}

if (typeof registerProcessor === 'function') {
  class VocalReducer extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
    }
    constructor() {
      super();
      this.dsp = new VocalReducerDSP(sampleRate);
      this.reportedMono = null;
      this.counter = 0;
    }
    process(inputs, outputs, parameters) {
      const input = inputs[0]; const output = outputs[0];
      if (!input || !input.length) return true;
      const L = input[0]; const R = input[1] || input[0];
      const amount = parameters.amount[0];
      this.dsp.process(L, R, output[0], output[1] || output[0], amount);
      if (++this.counter % 200 === 0 && this.reportedMono !== this.dsp.isMono) { // ~0,5 s
        this.reportedMono = this.dsp.isMono;
        this.port.postMessage({ mono: this.dsp.isMono });
      }
      return true;
    }
  }
  registerProcessor('vocal-reducer', VocalReducer);
}

if (typeof globalThis !== 'undefined' && typeof registerProcessor !== 'function') globalThis.VocalReducerDSP = VocalReducerDSP; // för tester i Node
