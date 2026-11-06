// Realtids-tonartsändring utan tempoändring: dubbel modulerad fördröjningslinje (granulär
// pitch shifter) med Hann-överbländning. O(1) per sampel – lätt nog för Celeron/Gemini Lake.
// Kräver secure context (localhost) – därför körs all DSP på TV:n, inte i mobilen.

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.window = Math.round(sampleRate * 0.07); // 70 ms korn
    let size = 1;
    while (size < this.window * 2 + 8) size <<= 1;
    this.size = size;
    this.mask = size - 1;
    this.buffers = [new Float32Array(size), new Float32Array(size)];
    this.write = 0;
    this.phase = 0;
    this.active = false;
  }

  read(buf, pos) {
    const i = Math.floor(pos);
    const f = pos - i;
    const a = buf[i & this.mask];
    const b = buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    const ratio = parameters.ratio[0];
    const frames = output[0].length;
    const channels = Math.min(output.length, 2);

    if (Math.abs(ratio - 1) < 1e-4) {
      // Bypass men fortsätt fylla bufferten så att aktivering inte klickar
      for (let ch = 0; ch < channels; ch++) {
        const inp = input[ch] || input[0];
        output[ch].set(inp);
        const buf = this.buffers[ch];
        let w = this.write;
        for (let n = 0; n < frames; n++) { buf[w] = inp[n]; w = (w + 1) & this.mask; }
      }
      this.write = (this.write + frames) & this.mask;
      return true;
    }

    const W = this.window;
    const step = (1 - ratio) / W; // fasändring per sampel
    for (let n = 0; n < frames; n++) {
      for (let ch = 0; ch < channels; ch++) {
        const inp = input[ch] || input[0];
        this.buffers[ch][this.write] = inp[n];
      }
      let p1 = this.phase;
      let p2 = p1 + 0.5; if (p2 >= 1) p2 -= 1;
      const d1 = p1 * W + 2;
      const d2 = p2 * W + 2;
      const g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p1);
      const g2 = 1 - g1; // Hann-par summerar till 1
      for (let ch = 0; ch < channels; ch++) {
        const buf = this.buffers[ch];
        const r1 = this.write - d1 + this.size;
        const r2 = this.write - d2 + this.size;
        output[ch][n] = this.read(buf, r1) * g1 + this.read(buf, r2) * g2;
      }
      this.write = (this.write + 1) & this.mask;
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;
    }
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifter);
