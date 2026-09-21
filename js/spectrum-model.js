(function (global) {
  'use strict';
  const VFD = (global.VFD = global.VFD || {});

  const DEFAULTS = {
    decayTau: 0.22, // s: exponential fall of the bar when the input drops
    peakHold: 0.8, // s: peak marker stays put after the last time the bar touched it
    peakGravity: 1.5, // full-scale units / s^2: then it falls like a dropped object
  };

  class SpectrumModel {
    constructor(bandCount, options) {
      this.opt = Object.assign({}, DEFAULTS, options);
      this.resize(bandCount);
    }

    resize(n) {
      this.count = n;
      this.bars = new Float32Array(n);
      this.peaks = new Float32Array(n);
      this.hold = new Float32Array(n);
      this.vel = new Float32Array(n);
    }

    update(targets, dt) {
      const { decayTau, peakHold, peakGravity } = this.opt;
      const k = Math.exp(-dt / decayTau);
      for (let i = 0; i < this.count; i++) {
        const t = targets[i];

        let bar = this.bars[i];
        bar = t >= bar ? t : Math.max(t, bar * k);
        if (bar < 0.005) bar = 0;
        this.bars[i] = bar;

        let p = this.peaks[i];
        if (bar >= p) {
          p = bar;
          this.hold[i] = peakHold;
          this.vel[i] = 0;
        } else if (this.hold[i] > 0) {
          this.hold[i] -= dt;
        } else {
          this.vel[i] += peakGravity * dt;
          p -= this.vel[i] * dt;
          if (p <= bar) {
            p = bar;
            this.vel[i] = 0;
          }
        }
        this.peaks[i] = p;
      }
    }
  }

  VFD.SpectrumModel = SpectrumModel;
})(window);
