(function (global) {
  'use strict';
  const VFD = (global.VFD = global.VFD || {});

  // ---- analysis constants -------------------------------------------------
  const F_MIN = 40;
  const F_MAX = 16000;
  const TILT_DB_PER_OCT = 4.0; // music falls ~4dB/oct per bin; compensate so highs are visible
  const TILT_REF_HZ = 1000;
  const RANGE_DB = 44; // displayed dynamic range (bottom..top of the bar)
  const FIXED_TOP_DB = -30; // top of scale when AGC is off
  const AGC_HEADROOM_FRACTION = 0.18; // of the displayed range: the loudest steady band sits just below the amber zone
  // MOTION: how big the bars swing. `emph` pushes each band away from its own running average (beats kick, dips fall
  // away) on top of the normal level, which is still set by the raw loudest band, so the display does not sink or
  // sag; a slightly narrower range and a lighter analyser smoothing add to it. NORMAL is the original behaviour.
  const MOTIONS = [
    { name: 'NORMAL', range: RANGE_DB, emph: 0, maxDev: 0, smooth: 0.8 },
    { name: 'LARGE', range: 40, emph: 1.0, maxDev: 16, smooth: 0.7 },
    { name: 'HUGE', range: 36, emph: 1.8, maxDev: 20, smooth: 0.55 },
  ];
  const MOTION_DEFAULT = 1;
  const MOTION_AVG_SEC = 1.2;
  const AGC_RELEASE_DB_PER_SEC = 2.5;
  const AGC_MIN_REF_DB = -58; // never boost the noise floor beyond this
  const DB_FLOOR = -140;
  // A microphone picking up a speaker (through the air, not a wire) loses a lot more level than any digital path,
  // and getUserMedia's raw gain varies a good deal between devices - an iPad in particular tends to come in much
  // quieter than a Mac, even with autoGainControl off. Boosting the mic path itself, not just the SENS trim (which
  // only shifts what is already there), lets the AGC actually see and lock onto quiet acoustic pickup.
  const MIC_GAIN_DB = 24;

  const EQ_BANDS = 15;
  const EQ_Q = 2.4;

  // DSP sound fields: synthetic room impulse responses (decaying noise that darkens as it fades), heard on the
  // speaker feed only - the analyser keeps looking at the dry signal. `wet` is the return level relative to the dry
  // signal for an impulse response of unit energy (the convolver's own auto-normalisation is switched off, since it
  // thins out long responses).
  const DSP_FIELDS = [
    null,
    { name: 'HALL', seconds: 2.4, decay: 2.6, preDelay: 0.03, wet: 0.42, bright: 0.85 },
    { name: 'LIVE', seconds: 1.1, decay: 3.2, preDelay: 0.012, wet: 0.34, bright: 1 },
    { name: 'CLUB', seconds: 0.55, decay: 3.8, preDelay: 0.006, wet: 0.3, bright: 0.7 },
  ];
  const LEVEL_FLOOR_DB = -60; // bottom of the stereo level meters

  const PREFERRED_HZ = [
    20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
    1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
  ];

  function snapLabel(f) {
    let best = PREFERRED_HZ[0];
    for (const p of PREFERRED_HZ) {
      if (Math.abs(Math.log(p / f)) < Math.abs(Math.log(best / f))) best = p;
    }
    if (best < 1000) return String(Math.round(best));
    const k = best / 1000;
    if (k >= 10) return Math.floor(k) + 'K';
    return String(Math.floor(k * 10 + 1e-6) / 10) + 'K';
  }

  function makeBands(count) {
    const ratio = Math.pow(F_MAX / F_MIN, 1 / count);
    const bands = [];
    for (let i = 0; i < count; i++) {
      const lo = F_MIN * Math.pow(ratio, i);
      const hi = lo * ratio;
      const center = Math.sqrt(lo * hi);
      bands.push({
        lo, hi, center,
        label: snapLabel(center),
        tilt: TILT_DB_PER_OCT * Math.log2(center / TILT_REF_HZ),
        i0: 0, i1: -1, mid: 0,
      });
    }
    return bands;
  }

  function bindBins(bands, sampleRate, fftSize, binCount) {
    const binHz = sampleRate / fftSize;
    for (const b of bands) {
      const lo = b.lo / binHz;
      const hi = b.hi / binHz;
      b.i0 = Math.ceil(lo);
      b.i1 = Math.min(Math.ceil(hi) - 1, binCount - 2);
      b.mid = (lo + hi) / 2;
    }
  }

  function softKnee(x) {
    if (x <= 0) return 0;
    if (x < 0.85) return x;
    return 0.85 + 0.15 * Math.tanh((x - 0.85) / 0.15);
  }

  // ---- demo source: a small synthesised stereo beat so the analyzer works without input ----
  const CHORDS = [
    { root: 55.0, tones: [220.0, 261.63, 329.63, 440.0] }, // Am
    { root: 43.65, tones: [174.61, 220.0, 261.63, 349.23] }, // F
    { root: 65.41, tones: [261.63, 329.63, 392.0, 523.25] }, // C
    { root: 49.0, tones: [196.0, 246.94, 293.66, 392.0] }, // G
  ];
  const ARP_PATTERN = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 3, 2];

  class DemoSynth {
    constructor(ctx) {
      this.ctx = ctx;
      this.tempo = 118;
      this.running = false;
      this.timer = null;
      this.step = 0;
      this.nextTime = 0;
      this.accum = 0;
      this.startedAt = 0;

      this.master = ctx.createGain();
      this.master.gain.value = 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      this.master.connect(comp);
      this.output = comp;
      this.bus = this.master;

      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }

    start() {
      if (this.running) return;
      const c = this.ctx;
      this.running = true;
      this.startedAt = c.currentTime;
      this.nextTime = c.currentTime + 0.08;
      this.master.gain.cancelScheduledValues(c.currentTime);
      this.master.gain.setTargetAtTime(0.6, c.currentTime, 0.02);
      this.timer = setInterval(() => this._schedule(), 25);
    }

    stop() {
      if (!this.running) return;
      const c = this.ctx;
      this.running = false;
      this.accum += c.currentTime - this.startedAt;
      clearInterval(this.timer);
      this.timer = null;
      this.master.gain.cancelScheduledValues(c.currentTime);
      this.master.gain.setTargetAtTime(0, c.currentTime, 0.04);
    }

    elapsed() {
      return this.accum + (this.running ? this.ctx.currentTime - this.startedAt : 0);
    }

    // node -> (optional stereo pan) -> master
    _to(node, pan) {
      if (!pan) {
        node.connect(this.bus);
        return;
      }
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      p.connect(this.bus);
    }

    _schedule() {
      const stepDur = 60 / this.tempo / 4;
      while (this.nextTime < this.ctx.currentTime + 0.15) {
        this._playStep(this.step, this.nextTime, stepDur);
        this.nextTime += stepDur;
        this.step++;
      }
    }

    _playStep(step, t, stepDur) {
      const bar = Math.floor(step / 16) % 4;
      const s = step % 16;
      const chord = CHORDS[bar];

      if (s % 4 === 0) this._kick(t, 0.95);
      else if (s === 10 && bar % 2 === 1) this._kick(t, 0.7);
      if (s === 4 || s === 12) this._snare(t, 1);
      if (bar === 3 && s >= 13) this._snare(t, 0.35 + (s - 13) * 0.15);

      if (s % 4 === 2) this._hat(t, 0.22, true);
      else if (s % 4 === 0) this._hat(t, 0.13, false);
      else this._hat(t, 0.07, false);

      if (s === 0) this._bass(t, chord.root, stepDur * 3.5);
      else if (s % 4 === 2) this._bass(t, chord.root * (s === 14 ? 2 : 1), stepDur * 1.6);

      // the arpeggio ping-pongs between the speakers
      this._arp(t, chord.tones[ARP_PATTERN[s]] * 2, stepDur * 1.4, s % 4 === 0 ? 0.2 : 0.13, s % 2 ? 0.6 : -0.6);

      if (s === 0) this._pad(t, chord.tones.slice(0, 3), stepDur * 16);
    }

    _kick(t, vel) {
      const c = this.ctx;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(170, t);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
      g.gain.setValueAtTime(vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
      o.connect(g);
      this._to(g, 0);
      o.start(t);
      o.stop(t + 0.4);
    }

    _noise(t, dur, type, freq, q, vel, pan) {
      const c = this.ctx;
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f);
      f.connect(g);
      this._to(g, pan);
      src.start(t, Math.random() * 0.5);
      src.stop(t + dur + 0.02);
    }

    _snare(t, vel) {
      const c = this.ctx;
      this._noise(t, 0.22, 'bandpass', 2100, 0.6, 0.6 * vel, 0);
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(230, t);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
      g.gain.setValueAtTime(0.4 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g);
      this._to(g, 0);
      o.start(t);
      o.stop(t + 0.16);
    }

    _hat(t, vel, open) {
      this._noise(t, open ? 0.24 : 0.045, 'highpass', 7500, 0.7, vel, open ? -0.35 : 0.35);
    }

    _bass(t, freq, dur) {
      const c = this.ctx;
      const o = c.createOscillator();
      const f = c.createBiquadFilter();
      const g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      f.type = 'lowpass';
      f.Q.value = 6;
      f.frequency.setValueAtTime(900, t);
      f.frequency.exponentialRampToValueAtTime(180, t + dur * 0.9);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.01);
      g.gain.setValueAtTime(0.5, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(f);
      f.connect(g);
      this._to(g, 0);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    _arp(t, freq, dur, vel, pan) {
      const c = this.ctx;
      const f = c.createBiquadFilter();
      const g = c.createGain();
      f.type = 'lowpass';
      f.Q.value = 3;
      f.frequency.setValueAtTime(3800, t);
      f.frequency.exponentialRampToValueAtTime(700, t + dur);
      g.gain.setValueAtTime(vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      f.connect(g);
      this._to(g, pan);
      [['sawtooth', 1], ['square', 1.005]].forEach(([type, mul]) => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = freq * mul;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.02);
      });
    }

    // detuned saws: the -7 cent voices sit left, the +7 cent voices right, so the pad is wide
    _pad(t, freqs, dur) {
      const c = this.ctx;
      [[-7, -0.75], [7, 0.75]].forEach(([detune, pan]) => {
        const f = c.createBiquadFilter();
        const g = c.createGain();
        f.type = 'lowpass';
        f.frequency.value = 1500;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.1, t + 0.4);
        g.gain.setValueAtTime(0.1, t + dur - 0.4);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        f.connect(g);
        this._to(g, pan);
        freqs.forEach((fr) => {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = fr;
          o.detune.value = detune;
          o.connect(f);
          o.start(t);
          o.stop(t + dur + 0.02);
        });
      });
    }
  }

  // Mac app only: the host process captures the system output (Core Audio tap) and hands it over as base64
  // interleaved float32 stereo chunks. This turns them back into an audio source: a small ring buffer read through
  // a ScriptProcessor, resampled to the context rate, with the latency kept bounded.
  class NativeFeed {
    constructor(ctx, srcRate) {
      this.rate = srcRate;
      this.cap = Math.ceil(srcRate * 2);
      this.l = new Float32Array(this.cap);
      this.r = new Float32Array(this.cap);
      this.w = 0; // frames written
      this.pos = 0; // read position in source frames (fractional)
      this.step = srcRate / ctx.sampleRate;
      this.node = ctx.createScriptProcessor(2048, 0, 2);
      this.node.onaudioprocess = (e) => this._process(e);
    }

    push(b64) {
      const bin = atob(b64);
      const n = bin.length & ~7; // whole stereo frames only
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
      const f = new Float32Array(bytes.buffer, 0, n >> 2);
      const frames = f.length >> 1;
      for (let i = 0; i < frames; i++) {
        const k = this.w % this.cap;
        this.l[k] = f[2 * i];
        this.r[k] = f[2 * i + 1];
        this.w++;
      }
    }

    _process(e) {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      if (this.w - this.pos > this.rate * 0.25) this.pos = this.w - this.rate * 0.06; // fell behind: catch up
      for (let i = 0; i < outL.length; i++) {
        if (this.w - this.pos < 2) {
          outL[i] = outR[i] = 0; // underrun
          continue;
        }
        const i0 = Math.floor(this.pos);
        const fr = this.pos - i0;
        const a = i0 % this.cap;
        const b = (i0 + 1) % this.cap;
        outL[i] = this.l[a] + (this.l[b] - this.l[a]) * fr;
        outR[i] = this.r[a] + (this.r[b] - this.r[a]) * fr;
        this.pos += this.step;
      }
    }

    close() {
      this.node.onaudioprocess = null;
      try { this.node.disconnect(); } catch (e) { /* already disconnected */ }
    }
  }

  // ---- engine ---------------------------------------------------------------
  //
  //  sources -> input -> 15-band graphic EQ -> limiter -> bus --+--> analyser (spectrum)
  //                                                             +--> splitter -> analyserL / analyserR (level meters)
  //                                                             +--> monitor (volume) -> speakers
  //
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.analyser = null;
      this.monitor = null;
      this.demo = null;
      this.media = null;
      this.mediaNode = null;
      this.mediaUrl = null;
      this.micStream = null;
      this.micNode = null;
      this.tabStream = null;
      this.tabNode = null;
      this.sysFeed = null;
      this.hold = false; // speaker output held back (the opening plays first)
      this.holdTimer = null;
      this.openingOut = null;
      this.noiseBuf = null;
      this.streamStartedAt = 0;
      this.source = null;
      this.onEnded = null;
      this.onTabEnded = null;
      this.uiSound = true;
      this.uiBuf = null;
      this.dsp = 0;
      this.verb = null;
      this.wet = null;
      this.irs = {};
      this.dspToken = 0;

      this.volume = 0.7;
      this.trimDb = 0;
      this.agc = true;
      this.agcRef = AGC_MIN_REF_DB;
      this.motionIdx = MOTION_DEFAULT;
      this.avgDb = new Float32Array(32); // per-band running mean level (dB), the reference for the emphasis
      this.shownDb = new Float32Array(32);
      this.avgInit = false;
      this.bandCount = 15;
      this.bands = makeBands(this.bandCount);
      this.weighted = new Float32Array(32);
      this.eqGains = new Float32Array(EQ_BANDS);
      this.eqLabels = makeBands(EQ_BANDS).map((b) => b.label);
    }

    async init() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

        this.input = ctx.createGain();
        this.micGain = ctx.createGain(); // mic-only boost (see MIC_GAIN_DB); never touches other sources
        this.micGain.gain.value = Math.pow(10, MIC_GAIN_DB / 20);
        this.micGain.connect(this.input);
        this.eq = makeBands(EQ_BANDS).map((b, i) => {
          const f = ctx.createBiquadFilter();
          f.type = 'peaking';
          f.frequency.value = b.center;
          f.Q.value = EQ_Q;
          f.gain.value = this.eqGains[i];
          return f;
        });
        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -2;
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.12;
        this.bus = ctx.createGain();

        let node = this.input;
        for (const f of this.eq) {
          node.connect(f);
          node = f;
        }
        node.connect(this.limiter);
        this.limiter.connect(this.bus);

        const an = (this.analyser = ctx.createAnalyser());
        an.fftSize = 4096;
        an.smoothingTimeConstant = MOTIONS[this.motionIdx].smooth;
        an.minDecibels = -100;
        an.maxDecibels = -10;
        this.freqData = new Float32Array(an.frequencyBinCount);

        const split = ctx.createChannelSplitter(2);
        this.anL = ctx.createAnalyser();
        this.anR = ctx.createAnalyser();
        this.anL.fftSize = this.anR.fftSize = 1024;
        this.anL.smoothingTimeConstant = this.anR.smoothingTimeConstant = 0;
        this.tdBuf = new Float32Array(1024);
        this.tdBuf2 = new Float32Array(1024);

        // analysers are dead ends; a muted sink keeps them pulled by the graph in every browser
        const sink = ctx.createGain();
        sink.gain.value = 0;
        sink.connect(ctx.destination);
        this.bus.connect(an);
        this.bus.connect(split);
        split.connect(this.anL, 0);
        split.connect(this.anR, 1);
        an.connect(sink);
        this.anL.connect(sink);
        this.anR.connect(sink);

        this.monitor = ctx.createGain();
        this.monitor.gain.value = this.volume;
        this.bus.connect(this.monitor);
        this.monitor.connect(ctx.destination);
        this.wet = ctx.createGain(); // reverb return: bus -> convolver -> wet -> monitor
        this.wet.gain.value = 0;
        this.wet.connect(this.monitor);

        bindBins(this.bands, ctx.sampleRate, an.fftSize, an.frequencyBinCount);
        if (this.dsp) this.setDsp(this.dsp);
      }
      await this.resume();
      this._primeIOS();
    }

    // On iOS Safari the very first thing scheduled after resume() can come out silent even though ctx.state
    // already reports 'running' - the hardware output only really wakes up once something has actually been
    // started. A single silent sample, started right away, absorbs that one-time hiccup so the opening jingle
    // (scheduled a moment later, well ahead of when it is heard) is not the thing that gets swallowed by it.
    _primeIOS() {
      if (this._primed || !this.ctx) return;
      this._primed = true;
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        src.connect(this.ctx.destination);
        src.start(0);
      } catch (e) { /* best-effort */ }
    }

    // Builds the audio context early (from a user gesture) so UI sounds can play before power-on.
    unlockUi() {
      return this.init();
    }

    // Mechanical UI sounds, sent straight to the speakers (not through the EQ / volume knob):
    // 'down' key press, 'up' key release, 'tick' knob detent, 'relay' power switch.
    click(kind, arg, opt) {
      const c = this.ctx;
      if (!this.uiSound || !c || c.state !== 'running') return;
      if (!this.uiBuf) {
        this.uiBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.1), c.sampleRate);
        const d = this.uiBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const t = c.currentTime;
      const out = c.createGain();
      out.gain.value = 0.55;
      out.connect(c.destination);
      const noise = (dur, hp, gain) => {
        const s = c.createBufferSource();
        s.buffer = this.uiBuf;
        const f = c.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = hp;
        const e = c.createGain();
        e.gain.setValueAtTime(gain, t);
        e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f);
        f.connect(e);
        e.connect(out);
        s.start(t, Math.random() * 0.03);
        s.stop(t + dur + 0.01);
      };
      const thud = (f0, f1, dur, gain) => {
        const o = c.createOscillator();
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        const e = c.createGain();
        e.gain.setValueAtTime(gain, t);
        e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(e);
        e.connect(out);
        o.start(t);
        o.stop(t + dur + 0.01);
      };
      if (kind === 'down') {
        noise(0.008, 1400, 0.16);
        thud(140, 60, 0.03, 0.2);
      } else if (kind === 'up') {
        noise(0.005, 2800, 0.08);
      } else if (kind === 'tick') {
        noise(0.004, 2200, 0.09);
        thud(900, 500, 0.006, 0.05);
      } else if (kind === 'relay') {
        noise(0.012, 900, 0.2);
        thud(90, 40, 0.07, 0.35);
      } else if (kind === 'loader') {
        // CD loader: a small DC motor spinning up and settling, gear noise over it, and a clunk at the end
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(46, t);
        o.frequency.linearRampToValueAtTime(128, t + 0.32);
        o.frequency.linearRampToValueAtTime(74, t + 0.72);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 640;
        const e = c.createGain();
        e.gain.setValueAtTime(0.0001, t);
        e.gain.linearRampToValueAtTime(0.12, t + 0.08);
        e.gain.setValueAtTime(0.12, t + 0.58);
        e.gain.exponentialRampToValueAtTime(0.0001, t + 0.78);
        o.connect(f);
        f.connect(e);
        e.connect(out);
        o.start(t);
        o.stop(t + 0.8);
        noise(0.7, 2600, 0.02);
        setTimeout(() => this.click('down'), 720);
      } else if (kind === 'servo') {
        // panel motor: a small geared servo spinning up, cruising, and winding down; a latch clunk at the end
        const dur = Math.max(0.25, (arg || 700) / 1000);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 760;
        const e = c.createGain();
        e.gain.setValueAtTime(0.0001, t);
        e.gain.linearRampToValueAtTime(0.085, t + 0.06);
        e.gain.setValueAtTime(0.085, t + Math.max(0.07, dur - 0.14));
        e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        f.connect(e);
        e.connect(out);
        [['sawtooth', 1, 1], ['square', 2.03, 0.35]].forEach(([type, mul, level]) => {
          const o = c.createOscillator();
          const og = c.createGain();
          og.gain.value = level;
          o.type = type;
          o.frequency.setValueAtTime(72 * mul, t);
          o.frequency.linearRampToValueAtTime(230 * mul, t + dur * 0.28);
          o.frequency.setValueAtTime(230 * mul, t + dur * 0.72);
          o.frequency.linearRampToValueAtTime(78 * mul, t + dur);
          o.connect(og);
          og.connect(f);
          o.start(t);
          o.stop(t + dur + 0.02);
        });
        noise(dur, 2300, 0.016);
        if (opt !== 'nolatch') setTimeout(() => this.click('down'), dur * 1000);
      }
      setTimeout(() => out.disconnect(), kind === 'loader' ? 1100 : kind === 'servo' ? (arg || 700) + 600 : 250);
    }

    async resume() {
      if (this.ctx && this.ctx.state !== 'running') {
        try { await this.ctx.resume(); } catch (e) { /* needs a user gesture */ }
      }
    }

    setMotion(idx) {
      this.motionIdx = idx;
      if (this.analyser) this.analyser.smoothingTimeConstant = MOTIONS[idx].smooth;
    }

    setBandCount(n) {
      this.bandCount = n;
      this.bands = makeBands(n);
      if (this.ctx) bindBins(this.bands, this.ctx.sampleRate, this.analyser.fftSize, this.analyser.frequencyBinCount);
    }

    setVolume(v) {
      this.volume = v;
      this._applyMonitor();
    }

    // DSP sound field 0..3 (OFF / HALL / LIVE / CLUB). The old tail is faded out before the impulse response is
    // swapped, so switching does not click; with the field off the convolver is disconnected and costs nothing.
    setDsp(idx) {
      this.dsp = idx;
      if (!this.ctx) return;
      const c = this.ctx;
      const token = ++this.dspToken;
      this.wet.gain.setTargetAtTime(0, c.currentTime, 0.015);
      setTimeout(() => {
        if (token !== this.dspToken) return;
        if (this.verb) {
          this.bus.disconnect(this.verb);
          this.verb.disconnect();
          this.verb = null;
        }
        const cfg = DSP_FIELDS[idx];
        if (!cfg) return;
        const v = c.createConvolver();
        v.normalize = false; // must be set before the buffer
        v.buffer = this._impulse(idx);
        this.bus.connect(v);
        v.connect(this.wet);
        this.verb = v;
        this.wet.gain.setTargetAtTime(cfg.wet, c.currentTime, 0.05);
      }, 90);
    }

    _impulse(idx) {
      if (this.irs[idx]) return this.irs[idx];
      const c = this.ctx;
      const cfg = DSP_FIELDS[idx];
      const rate = c.sampleRate;
      const n = Math.floor(rate * cfg.seconds);
      const pre = Math.floor(rate * cfg.preDelay);
      const buf = c.createBuffer(2, n, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = pre; i < n; i++) {
          const u = (i - pre) / (n - pre);
          lp += (Math.random() * 2 - 1 - lp) * Math.min(1, cfg.bright * (1 - 0.8 * u) + 0.05);
          d[i] = lp * Math.pow(1 - u, cfg.decay);
        }
        let energy = 0;
        for (let i = pre; i < n; i++) energy += d[i] * d[i];
        const g = 1 / Math.sqrt(energy || 1);
        for (let i = pre; i < n; i++) d[i] *= g;
      }
      return (this.irs[idx] = buf);
    }

    // gains: dB per EQ band (15 values)
    setEq(gains) {
      this.eqGains.set(gains);
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      for (let i = 0; i < EQ_BANDS; i++) this.eq[i].gain.setTargetAtTime(gains[i], t, 0.03);
    }

    _applyMonitor(tau) {
      if (!this.monitor) return;
      // never monitor the mic (feedback) or a captured tab (it is already audible from that tab)
      const silent = this.source === 'mic' || this.source === 'tab' || this.hold;
      this.monitor.gain.setTargetAtTime(silent ? 0 : this.volume, this.ctx.currentTime, tau || 0.02);
    }

    // Keeps the speakers quiet for `ms` (0 releases at once) so a source that starts with the unit does not talk
    // over the power-on opening; it fades in when the hold ends.
    holdOutput(ms) {
      clearTimeout(this.holdTimer);
      this.hold = ms > 0;
      this._applyMonitor();
      if (this.hold) this.holdTimer = setTimeout(() => this.releaseOutput(), ms);
    }

    releaseOutput() {
      clearTimeout(this.holdTimer);
      if (!this.hold) return;
      this.hold = false;
      this._applyMonitor(0.12);
    }

    _noise() {
      if (!this.noiseBuf) {
        const c = this.ctx;
        const b = c.createBuffer(1, Math.floor(c.sampleRate * 1.5), c.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = b;
      }
      return this.noiseBuf;
    }

    // The power-on jingle, on the same timeline as the display (VFD.OPENING): a blip for the display check, a rising
    // sweep as the line of light draws out, an FM-bell arpeggio for the logo over a low swell, a whoosh under the
    // spectrum wave, a key tick per typed letter and a soft closing chord. `from` = seconds of the opening that
    // have already gone by, so everything stays in step with the picture.
    // The power-on jingle, scored against the opening's timeline (VFD.OPENING in the renderer file): every visual event
    // has its sound at the same instant. Layers: display-check pings and a rising heater whine; a laser sweep as the
    // line of light draws out; a swelling pad while the logo ignites, one bell per character (an ascending C major
    // arpeggio panned left to right like the letters); a swish that follows the glint; a riser and a big impact
    // (kick, noise burst, chord) as the display flares; a pentatonic run that follows the bars erupting left to right;
    // and a resolved chord with a shimmer as HELLO appears. Everything feeds a bus with two dark echoes for space, a
    // gentle compressor keeps the stack from clipping, and speakers stay muted until it ends (holdOutput).
    playOpening(from) {
      const c = this.ctx;
      if (!this.uiSound || !c || c.state !== 'running') return;
      this.stopOpening();
      const O = global.VFD.OPENING;
      const skip = from || 0;
      const base = c.currentTime - skip;
      const out = c.createGain();
      out.gain.value = 0.38 * (0.35 + 0.65 * this.volume);
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 10;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.3;
      out.connect(comp);
      comp.connect(c.destination);
      this.openingOut = out;

      const makePan = (v) => {
        const p = c.createStereoPanner ? c.createStereoPanner() : c.createGain();
        if (p.pan) p.pan.value = v || 0;
        return p;
      };
      // the shared bus: dry, plus a send into a pair of dark echoes (left 0.19 s, right 0.29 s)
      const bus = c.createGain();
      bus.connect(out);
      const send = c.createGain();
      send.gain.value = 0.3;
      bus.connect(send);
      [[0.19, -0.7], [0.29, 0.7]].forEach(([d, pan]) => {
        const dl = c.createDelay(1);
        dl.delayTime.value = d;
        const fb = c.createGain();
        fb.gain.value = 0.36;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3200;
        const pn = makePan(pan);
        send.connect(dl);
        dl.connect(lp);
        lp.connect(fb);
        fb.connect(dl);
        lp.connect(pn);
        pn.connect(out);
      });
      // where a voice goes: through its own pan position into the bus (or straight to the output for weight)
      const dest = (pan, dry) => {
        if (!pan) return dry ? out : bus;
        const p = makePan(pan);
        p.connect(dry ? out : bus);
        return p;
      };

      const live = (t) => base + t > c.currentTime + 0.01;
      const shape = (g, t, peak, attack, decay) => {
        g.gain.setValueAtTime(0.0001, base + t);
        g.gain.exponentialRampToValueAtTime(peak, base + t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, base + t + attack + decay);
      };
      // `smooth` swells and fades linearly (sweeps and pads); otherwise the exponential decay of a struck note
      const tone = (type, f0, f1, t, dur, peak, attack, smooth, pan, dry) => {
        if (!live(t)) return;
        const o = c.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f0, base + t);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, base + t + dur);
        const g = c.createGain();
        if (smooth) {
          g.gain.setValueAtTime(0, base + t);
          g.gain.linearRampToValueAtTime(peak, base + t + attack);
          g.gain.linearRampToValueAtTime(0, base + t + dur);
        } else {
          shape(g, t, peak, attack, dur - attack);
        }
        o.connect(g);
        g.connect(dest(pan, dry));
        o.start(base + t);
        o.stop(base + t + dur + 0.05);
      };
      // an FM bell: bright strike, mellow decay
      const bell = (f, t, dur, peak, pan) => {
        if (!live(t)) return;
        const car = c.createOscillator();
        const mod = c.createOscillator();
        car.frequency.value = f;
        mod.frequency.value = f * 3.5;
        const mg = c.createGain();
        mg.gain.setValueAtTime(f * 1.4, base + t);
        mg.gain.exponentialRampToValueAtTime(f * 0.03, base + t + dur * 0.55);
        mod.connect(mg);
        mg.connect(car.frequency);
        const g = c.createGain();
        shape(g, t, peak, 0.006, dur);
        car.connect(g);
        g.connect(dest(pan));
        car.start(base + t);
        mod.start(base + t);
        car.stop(base + t + dur + 0.05);
        mod.stop(base + t + dur + 0.05);
      };
      // a warm pad: two detuned saws per note through a low-pass that opens over the note
      const pad = (freqs, t, dur, peak, attack, release, fc0, fc1) => {
        if (!live(t)) return;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 0.7;
        lp.frequency.setValueAtTime(fc0, base + t);
        lp.frequency.exponentialRampToValueAtTime(fc1, base + t + dur);
        const g = c.createGain();
        g.gain.setValueAtTime(0, base + t);
        g.gain.linearRampToValueAtTime(peak / freqs.length, base + t + attack);
        g.gain.setValueAtTime(peak / freqs.length, base + t + dur - release);
        g.gain.linearRampToValueAtTime(0, base + t + dur);
        lp.connect(g);
        g.connect(bus);
        freqs.forEach((f) => [-7, 7].forEach((cents) => {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = f;
          o.detune.value = cents;
          o.connect(lp);
          o.start(base + t);
          o.stop(base + t + dur + 0.05);
        }));
      };
      // band-passed noise that sweeps in pitch and across the stereo field
      const swish = (t, dur, f0, f1, peak, pan0, pan1, q) => {
        if (!live(t)) return;
        const src = c.createBufferSource();
        src.buffer = this._noise();
        src.loop = true;
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = q;
        bp.frequency.setValueAtTime(f0, base + t);
        bp.frequency.exponentialRampToValueAtTime(f1, base + t + dur);
        const g = c.createGain();
        g.gain.setValueAtTime(0, base + t);
        g.gain.linearRampToValueAtTime(peak, base + t + dur * 0.55);
        g.gain.linearRampToValueAtTime(0, base + t + dur);
        const pn = makePan(pan0);
        if (pn.pan) {
          pn.pan.setValueAtTime(pan0, base + t);
          pn.pan.linearRampToValueAtTime(pan1, base + t + dur);
        }
        src.connect(bp);
        bp.connect(g);
        g.connect(pn);
        pn.connect(bus);
        src.start(base + t);
        src.stop(base + t + dur + 0.05);
      };
      // a burst of filtered noise that dies away (the crack and the cymbal of the impact)
      const burst = (t, dur, peak, type, fc) => {
        if (!live(t)) return;
        const src = c.createBufferSource();
        src.buffer = this._noise();
        const f = c.createBiquadFilter();
        f.type = type;
        f.frequency.value = fc;
        const g = c.createGain();
        shape(g, t, peak, 0.002, dur);
        src.connect(f);
        f.connect(g);
        g.connect(bus);
        src.start(base + t, Math.random() * 0.4);
        src.stop(base + t + dur + 0.05);
      };
      const tick = (t, peak) => burst(t, 0.012, peak || 0.3, 'highpass', 3000);
      const kick = (t, peak) => tone('sine', 150, 40, t, 0.5, peak, 0.002, false, 0, true);

      const C = 261.63; // middle C: the whole piece is in C major (the impact chord is C add 9)
      const semi = (n) => C * Math.pow(2, n / 12);
      const wide = (i, n) => -0.9 + (1.8 * i) / Math.max(1, n - 1); // left ... right

      // --- display check: two pings, and the heater whine climbing under them
      tone('triangle', 60, 520, 0.1, 0.7, 0.06, 0.4, true);
      tone('sine', 1760, 1760, O.testStart, 0.09, 0.26, 0.003);
      tone('sine', 2349.3, 2349.3, 0.38, 0.13, 0.24, 0.003);
      // --- the line of light: a laser sweep, and sparks
      tone('sine', 220, 3400, O.lineStart, O.lineEnd - O.lineStart + 0.04, 0.26, 0.15, true);
      tone('triangle', 110, 1700, O.lineStart, O.lineEnd - O.lineStart + 0.04, 0.1, 0.15, true);
      for (let i = 0; i < 7; i++) tick(O.lineStart + 0.08 + i * 0.05, 0.12);
      // --- the band swells: an airy rise, a sub-bass swell and the pad that carries the logo
      swish(O.lineEnd, O.irisEnd - O.lineEnd + 0.1, 400, 4200, 0.16, -0.3, 0.3, 0.9);
      tone('sine', 65.41, 65.41, 1.1, 2.6, 0.3, 1.0, true, 0, true);
      pad([130.81, 196, 293.66, 329.63, 493.88], 1.3, O.collapseStart + 0.35 - 1.3, 0.16, 1.1, 0.5, 350, 3200);
      // --- VFD-5000: one bell per character, an ascending C major arpeggio panned across the display like the letters
      [semi(0) * 2, semi(4) * 2, semi(7) * 2, 0, semi(0) * 4, semi(4) * 4, semi(7) * 4, semi(0) * 8].forEach((f, k) => {
        const t = O.letterStart + k * O.letterGap;
        if (!f) tone('sine', 196, 98, t, 0.3, 0.3, 0.004, false, 0, true); // the dash: a soft low thump
        else bell(f, t, k === 7 ? 2.2 : 1.6, k === 7 ? 0.3 : 0.36, wide(k, 8) * 0.85);
      });
      // --- the subtitle spreads out: a soft shimmer; then the glint: a swish that follows the slit across the screen
      tone('triangle', 2093, 3136, O.subStart, O.subEnd - O.subStart, 0.05, 0.4, true);
      swish(O.glintStart, O.glintEnd - O.glintStart, 900, 9000, 0.22, -1, 1, 1.6);
      tone('sine', 1046.5, 4186, O.glintStart, O.glintEnd - O.glintStart, 0.08, 0.3, true);
      // --- build-up: a riser into the collapse
      swish(O.collapseStart - 0.15, O.flashAt - O.collapseStart + 0.15, 200, 6000, 0.24, 0, 0, 0.8);
      tone('sine', 110, 1100, O.collapseStart - 0.15, O.flashAt - O.collapseStart + 0.15, 0.2, 0.34, true);
      // --- impact: kick, crack, cymbal, sub, and the chord
      kick(O.flashAt, 0.95);
      burst(O.flashAt, 0.5, 0.5, 'lowpass', 1800);
      burst(O.flashAt, 1.0, 0.16, 'highpass', 6000);
      tone('sine', 65.41, 65.41, O.flashAt, 1.8, 0.4, 0.01, false, 0, true);
      [semi(-12), semi(-5), semi(0), semi(4), semi(7), semi(12)].forEach((f, i) => bell(f, O.flashAt + i * 0.012, 2.2, 0.3 - i * 0.02, wide(i, 6) * 0.6));
      // --- eruption: a pentatonic run that climbs with the bars (C4 up to A6), left to right
      for (let i = 0; i < 15; i++) {
        const n = [0, 2, 4, 7, 9][i % 5] + 12 * Math.floor(i / 5);
        bell(semi(n), O.sweepStart + (O.sweepSpan * i) / 14, 0.55, 0.2, wide(i, 15));
      }
      // --- finale: the resolved chord, a strummed bell chord, the sub, HELLO's key ticks and a rising shimmer
      pad([semi(0), semi(4), semi(7), semi(11), semi(14)], O.helloStart, 3.0, 0.2, 0.06, 2.2, 1500, 5000);
      [semi(12), semi(16), semi(19), semi(23), semi(26)].forEach((f, i) => bell(f, O.helloStart + i * 0.05, 2.6, 0.26, wide(i, 5) * 0.7));
      tone('sine', 65.41, 65.41, O.helloStart, 2.4, 0.3, 0.05, false, 0, true);
      for (let i = 0; i < 5; i++) tick(O.helloStart + i * 0.09, 0.22);
      [semi(24), semi(28), semi(31), semi(36)].forEach((f, i) => bell(f, O.helloStart + 0.75 + i * 0.12, 1.5, 0.13, i % 2 ? 0.6 : -0.6));

      setTimeout(() => {
        if (this.openingOut !== out) return;
        this.openingOut = null;
        try { out.disconnect(); } catch (e) { /* already gone */ }
      }, Math.max(600, (8.4 - skip) * 1000));
    }

    stopOpening() {
      const o = this.openingOut;
      if (!o) return;
      this.openingOut = null;
      o.gain.cancelScheduledValues(this.ctx.currentTime);
      o.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
      setTimeout(() => { try { o.disconnect(); } catch (e) { /* already gone */ } }, 400);
    }

    _detach() {
      if (this.demo) this.demo.stop();
      if (this.media) this.media.pause();
      if (this.micNode) {
        this.micNode.disconnect();
        this.micNode = null;
      }
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = null;
      }
      if (this.tabNode) {
        this.tabNode.disconnect();
        this.tabNode = null;
      }
      if (this.sysFeed) {
        this.sysFeed.close();
        this.sysFeed = null;
        if (global.vfdNative) global.vfdNative.audio = null;
        const bridge = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.vfd;
        if (bridge) bridge.postMessage({ cmd: 'sysStop' });
      }
      if (this.tabStream) {
        this.tabStream.getTracks().forEach((t) => t.stop());
        this.tabStream = null;
      }
    }

    stopAll() {
      this._detach();
      this.source = null;
    }

    async useDemo() {
      this._detach();
      if (!this.demo) {
        this.demo = new DemoSynth(this.ctx);
        this.demo.output.connect(this.input);
      }
      this.demo.start();
      this.source = 'demo';
      this._applyMonitor();
    }

    async useMic() {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this._detach();
      this.micStream = stream;
      this.micNode = this.ctx.createMediaStreamSource(stream);
      this.micNode.connect(this.micGain);
      this.streamStartedAt = this.ctx.currentTime;
      this.source = 'mic';
      this._applyMonitor();
    }

    static tabCaptureSupported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    }

    // Visualise another browser tab (YouTube, a streaming site, ...): Chrome/Edge only, and the user has to
    // pick the tab and tick "share tab audio" in the browser's own picker.
    // In the Mac app the TAB key captures the whole system output instead (see NativeFeed).
    async _useNativeSystem() {
      const bridge = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.vfd;
      if (!bridge) throw new Error('unsupported');
      if (!this.sysFeed) {
        const native = (global.vfdNative = global.vfdNative || {});
        const info = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 25000); // the first start can sit behind a permission prompt
          native.status = (state, detail) => {
            clearTimeout(timer);
            if (state === 'ok') resolve(detail || {});
            else reject(new Error(state));
          };
          bridge.postMessage({ cmd: 'sysStart' });
        });
        this._detach();
        const feed = new NativeFeed(this.ctx, info.rate || 48000);
        feed.node.connect(this.input);
        native.audio = (b64) => feed.push(b64);
        this.sysFeed = feed;
        this.streamStartedAt = this.ctx.currentTime;
      }
      this.source = 'tab';
      this._applyMonitor();
    }

    async useTab() {
      if (global.VFD_NATIVE) return this._useNativeSystem();
      if (!AudioEngine.tabCaptureSupported()) throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: 320, height: 180 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const audio = stream.getAudioTracks();
      if (!audio.length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('no-audio');
      }
      this._detach();
      this.tabStream = stream; // the (tiny) video track stays alive: some browsers end the share without it
      this.tabNode = this.ctx.createMediaStreamSource(new MediaStream(audio));
      this.tabNode.connect(this.input);
      audio[0].addEventListener('ended', () => {
        if (this.source === 'tab' && this.onTabEnded) this.onTabEnded();
      });
      this.streamStartedAt = this.ctx.currentTime;
      this.source = 'tab';
      this._applyMonitor();
    }

    async useFile(file) {
      this._ensureMedia();
      this._detach();
      if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
      this.mediaUrl = URL.createObjectURL(file);
      this.media.src = this.mediaUrl;
      this.source = 'file';
      this._applyMonitor();
      await this.media.play();
    }

    _ensureMedia() {
      if (this.media) return;
      this.media = new Audio();
      this.media.addEventListener('ended', () => {
        if (this.source === 'file' && this.onEnded) this.onEnded();
      });
      this.mediaNode = this.ctx.createMediaElementSource(this.media);
      this.mediaNode.connect(this.input);
    }

    async reuseFile() {
      this._detach();
      this.source = 'file';
      this._applyMonitor();
      await this.media.play();
    }

    hasFile() {
      return !!this.mediaUrl;
    }

    isPlaying() {
      if (this.source === 'demo') return !!(this.demo && this.demo.running);
      if (this.source === 'file') return !!(this.media && !this.media.paused);
      return this.source === 'mic' || this.source === 'tab';
    }

    async togglePlay() {
      if (this.source === 'demo') {
        if (this.demo.running) this.demo.stop();
        else this.demo.start();
      } else if (this.source === 'file') {
        if (this.media.paused) await this.media.play();
        else this.media.pause();
      }
    }

    restartFile() {
      if (this.media) this.media.currentTime = 0;
      return this.media ? this.media.play() : Promise.resolve();
    }

    seek(deltaSec) {
      if (this.source === 'file' && this.media) {
        const d = this.media.duration;
        let t = this.media.currentTime + deltaSec;
        if (Number.isFinite(d)) t = Math.min(d - 0.05, t);
        this.media.currentTime = Math.max(0, t);
      }
    }

    getTime() {
      if (this.source === 'file' && this.media) return this.media.currentTime;
      if (this.source === 'demo' && this.demo) return this.demo.elapsed();
      if (this.source === 'mic' || this.source === 'tab') return this.ctx.currentTime - this.streamStartedAt;
      return 0;
    }

    // Fills out[0..bandCount) with 0..1 levels (log frequency, log amplitude).
    getBandLevels(out, dt) {
      const n = this.bandCount;
      if (!this.analyser) {
        out.fill(0);
        return out;
      }
      const f = this.freqData;
      this.analyser.getFloatFrequencyData(f);
      const bands = this.bands;
      const weighted = this.weighted;
      let framePeak = DB_FLOOR;

      for (let i = 0; i < n; i++) {
        const b = bands[i];
        let db;
        if (b.i1 < b.i0) {
          const idx = Math.max(0, Math.floor(b.mid));
          const frac = b.mid - idx;
          const a = Math.max(f[idx], DB_FLOOR);
          const c = Math.max(f[idx + 1], DB_FLOOR);
          db = a * (1 - frac) + c * frac;
        } else {
          let p = 0;
          for (let k = b.i0; k <= b.i1; k++) {
            const v = f[k];
            p += v > DB_FLOOR ? Math.pow(10, v / 10) : 1e-14;
          }
          db = 10 * Math.log10(p / (b.i1 - b.i0 + 1));
        }
        db += b.tilt;
        weighted[i] = db;
        if (db > framePeak) framePeak = db;
      }

      // MOTION emphasis: exaggerate how far each band is from its own running average. The AGC below still follows
      // the raw loudest band, so only the swing grows, not the overall level.
      const m = MOTIONS[this.motionIdx];
      const avg = this.avgDb;
      const shown = this.shownDb;
      const k = 1 - Math.exp(-Math.max(dt, 0.001) / MOTION_AVG_SEC);
      for (let i = 0; i < n; i++) {
        if (!this.avgInit || avg[i] < DB_FLOOR + 1) avg[i] = weighted[i];
        const dev = Math.max(-m.maxDev, Math.min(m.maxDev, weighted[i] - avg[i]));
        avg[i] += (weighted[i] - avg[i]) * k;
        shown[i] = weighted[i] + m.emph * dev;
      }
      this.avgInit = true;

      let top;
      if (this.agc) {
        if (framePeak > this.agcRef) this.agcRef += (framePeak - this.agcRef) * 0.4;
        else this.agcRef -= AGC_RELEASE_DB_PER_SEC * dt;
        if (this.agcRef < AGC_MIN_REF_DB) this.agcRef = AGC_MIN_REF_DB;
        top = this.agcRef + m.range * AGC_HEADROOM_FRACTION;
      } else {
        top = FIXED_TOP_DB;
      }
      const bottom = top - m.range;

      for (let i = 0; i < n; i++) {
        const x = (shown[i] + this.trimDb - bottom) / m.range;
        out[i] = softKnee(Math.min(x, 1.2));
      }
      return out;
    }

    // Time-domain samples of the mixed output (mono, -1..1) for the SCOPE pattern; `out` has 1024 entries.
    getWave(out) {
      if (!this.anL) {
        out.fill(0);
        return out;
      }
      this.anL.getFloatTimeDomainData(this.tdBuf);
      this.anR.getFloatTimeDomainData(this.tdBuf2);
      for (let i = 0; i < out.length; i++) out[i] = 0.5 * (this.tdBuf[i] + this.tdBuf2[i]);
      return out;
    }

    // Sample-peak level of the left / right channel, mapped 0..1 over LEVEL_FLOOR_DB..0 dBFS.
    getStereoLevels(out) {
      if (!this.anL) {
        out[0] = out[1] = 0;
        return out;
      }
      const buf = this.tdBuf;
      const pair = [this.anL, this.anR];
      for (let ch = 0; ch < 2; ch++) {
        pair[ch].getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i] < 0 ? -buf[i] : buf[i];
          if (v > peak) peak = v;
        }
        const db = peak > 1e-6 ? 20 * Math.log10(peak) : LEVEL_FLOOR_DB;
        out[ch] = Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
      }
      return out;
    }
  }

  AudioEngine.makeBands = makeBands;
  AudioEngine.EQ_BANDS = EQ_BANDS;
  AudioEngine.MOTIONS = MOTIONS;
  AudioEngine.MOTION_DEFAULT = MOTION_DEFAULT;
  AudioEngine.DSP_NAMES = DSP_FIELDS.map((f) => (f ? f.name : 'OFF'));
  AudioEngine.LEVEL_FLOOR_DB = LEVEL_FLOOR_DB;

  VFD.AudioEngine = AudioEngine;
  VFD.DemoSynth = DemoSynth;
})(window);
