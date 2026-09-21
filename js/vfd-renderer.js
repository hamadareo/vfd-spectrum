(function (global) {
  'use strict';
  const VFD = (global.VFD = global.VFD || {});

  // Logical drawing space; the backing store is scaled from this.
  const W = 960;
  const H = 420;
  const PAD_X = 28;

  // spectrum / EQ area
  const ROWS = 16;
  const SPEC_TOP = 96;
  const SPEC_H = 242;
  const PITCH_Y = SPEC_H / ROWS;
  const GAP_Y = 3.2;
  const SEG_H = PITCH_Y - GAP_Y;
  const MAX_BAR_W = 54;

  // SCOPE pattern: the waveform drawn with the same segments, one column per 8 px
  const SC_COLS = 113;
  const SC_PITCH = (W - PAD_X * 2) / SC_COLS;
  const SC_W = SC_PITCH * 0.72;
  const SC_SPAN = 768; // samples across the screen

  // PERSPECTIVE ("fan") pattern: rows stay horizontal while the columns run toward a vanishing point below the
  // display, so every bar widens and leans outward as it rises, like the spectrum on some real head units.
  const FAN_BASE_SPAN = 630;
  const FAN_TOP_SCALE = 1.42;
  const FAN_CELL_Y = SPEC_TOP + SPEC_H + 8;
  const FAN_CELL_H = 11;

  // dot-matrix status line
  const STATUS_Y = 16;
  const DOT_PITCH = 3;
  const DOT_SIZE = 2.3;
  const CHAR_W = 6 * DOT_PITCH;
  const LEFT_CELLS = 30;
  const RIGHT_CELLS = 16;
  const RIGHT_X = W - PAD_X - RIGHT_CELLS * CHAR_W + DOT_PITCH;

  // title line: 16-row dot matrix under the status line, able to show Japanese (half-width 8 cols, full-width 16)
  const TITLE_Y = 47;
  const TITLE_ROWS = 16;
  const TITLE_PITCH = 2.2;
  const TITLE_SIZE = 1.8;
  const TITLE_COLS = Math.floor((W - PAD_X * 2) / TITLE_PITCH);
  const TITLE_HOLD_MS = 1800; // rest at the start of a scrolling title before it moves
  const TITLE_COLS_PER_MS = 1 / 18; // ~55 dot columns per second
  const TITLE_GAP_COLS = 30;

  const LABEL_Y = 352;
  const LABEL_PITCH = 2;
  const LABEL_SIZE = 1.6;

  // stereo level meters
  const LV_SEGS = 48;
  const LV_X0 = 96;
  const LV_X1 = W - PAD_X;
  const LV_PITCH = (LV_X1 - LV_X0) / LV_SEGS;
  const LV_GAP = 3.2;
  const LV_SEGW = LV_PITCH - LV_GAP;
  const LV_H = 70;
  const LV_Y = [96, 176];
  const LV_TICKS = [-60, -40, -30, -20, -12, -6, 0];
  const LV_TICK_Y = 254;
  const LV_LABEL_Y = 266;
  const LV_READ_Y = 304;
  const LV_READ_PITCH = 4;
  const LV_READ_SIZE = 3.2;
  const LV_READ_CELLS = 26;
  const LV_CH_PITCH = 6;
  const LV_CH_SIZE = 4.8;

  // clock: big slanted 7-segment digits (with the unlit "88:88" ghost behind them), date line, seconds bar
  const D7_W = 72;
  const D7_H = 128;
  const D7_T = 15;
  const D7_G = 2.4;
  const D7_SLANT = 0.09;
  const D7_GAP = 22;
  const COLON_W = 34;
  const D7_TOTAL = 4 * D7_W + 4 * D7_GAP + COLON_W;
  const D7_X0 = (W - D7_TOTAL) / 2 - (D7_H * D7_SLANT) / 2;
  const D7_Y = 62;
  const D7_XS = [D7_X0, D7_X0 + D7_W + D7_GAP];
  D7_XS.push(D7_X0 + 2 * (D7_W + D7_GAP) + COLON_W + D7_GAP);
  D7_XS.push(D7_XS[2] + D7_W + D7_GAP);
  const COLON_X = D7_X0 + 2 * (D7_W + D7_GAP) + COLON_W / 2;
  const DATE_PITCH = 4;
  const DATE_SIZE = 3.2;
  const DATE_CELLS = 11;
  const DATE_X = (W - (DATE_CELLS * 6 * DATE_PITCH - DATE_PITCH)) / 2;
  const DATE_Y = 222;
  const SEC_SEGS = 60;
  const SEC_PITCH = 14;
  const SEC_X = (W - SEC_SEGS * SEC_PITCH) / 2 + 2;
  const SEC_Y = 292;

  // volume on-screen display: label, two big 7-segment digits and a 40-segment bar
  const OSD_SEGS = 40;
  const OSD_BAR_Y = 262;
  const OSD_BAR_PITCH = 22;
  const OSD_BAR_X = (W - (OSD_SEGS * OSD_BAR_PITCH - 4)) / 2;
  const OSD_DIGIT_X = [(W - (2 * D7_W + D7_GAP)) / 2 + 74, (W - (2 * D7_W + D7_GAP)) / 2 + 74 + D7_W + D7_GAP];
  const OSD_LABEL_X = 92;
  const OSD_LABEL_Y = D7_Y + 36;
  const OSD_LABEL_PITCH = 8;
  const OSD_LABEL_SIZE = 6.6;

  // annunciators: fixed-shape indicators along the bottom edge. On a real VFD they are always present,
  // faintly visible when off. Solid (touching-dot) glyphs so they read as printed shapes, not dot text.
  const ANN_Y = 391;
  const ANN_PITCH = 2;
  const ANN_ITEMS = [
    { id: 'play', icon: 'play' },
    { id: 'pause', icon: 'pause' },
    { id: 'demo', text: 'DEMO' },
    { id: 'mic', text: 'MIC' },
    { id: 'tab', text: window.VFD_NATIVE ? 'SYS' : 'TAB' }, // the Mac app captures the system output here
    { id: 'file', text: 'FILE' },
    { id: 'st', text: 'ST' },
    { id: 'eq', text: 'EQ' },
    { id: 'agc', text: 'AGC' },
    { id: 'dim', text: 'DIM' },
    { id: 'sync', text: 'SYNC' },
    { id: 'rpt', text: 'RPT' },
    { id: 'mute', text: 'MUTE' },
  ];
  (function layoutAnn() {
    let total = 0;
    for (const it of ANN_ITEMS) {
      it.w = it.icon ? 12 : it.text.length * 6 * ANN_PITCH - ANN_PITCH;
      total += it.w;
    }
    const gap = (W - PAD_X * 2 - total) / (ANN_ITEMS.length - 1);
    let x = PAD_X;
    for (const it of ANN_ITEMS) {
      it.x = x;
      x += it.w + gap;
    }
  })();
  const STANDBY_GAIN = 0.45;

  const SEG_PAD = 1.8; // logical px of soft skirt around a segment sprite
  const TEXT_PAD = 4; // ... and around a text sprite (room for the glow passes)

  // Unlit glass: dark, slightly tinted grey at ~8.5% opacity, as required.
  const UNLIT_ALPHA = 0.085;
  const SEG_RELEASE_TAU = 0.055; // s: phosphor afterglow of a switched-off segment
  // Halation: the lit layer is down-sampled to 1/2, 1/4, 1/8 and 1/16 size (each step from the previous
  // one, so every level is a progressively wider blur) and the levels are summed with individual weights.
  // Wide levels weigh most, giving a long soft tail.
  const HALO_DIVISORS = [2, 4, 8, 16];
  const HALO_WEIGHTS = [0.02, 0.04, 0.12, 0.33];
  const HALO_SMEARS = [0, 0, 1, 2]; // extra 3-tap blur iterations per level (widens the tail)

  // 5x7 dot-matrix font: 5 column bytes per glyph, bit0 = top row.
  const FONT = {
    ' ': [0x00, 0x00, 0x00, 0x00, 0x00],
    '-': [0x08, 0x08, 0x08, 0x08, 0x08],
    '+': [0x08, 0x08, 0x3e, 0x08, 0x08],
    '.': [0x00, 0x60, 0x60, 0x00, 0x00],
    ',': [0x00, 0x50, 0x30, 0x00, 0x00],
    ':': [0x00, 0x36, 0x36, 0x00, 0x00],
    '/': [0x20, 0x10, 0x08, 0x04, 0x02],
    '>': [0x00, 0x41, 0x22, 0x14, 0x08],
    '<': [0x08, 0x14, 0x22, 0x41, 0x00],
    '=': [0x14, 0x14, 0x14, 0x14, 0x14],
    '%': [0x23, 0x13, 0x08, 0x64, 0x62],
    '?': [0x02, 0x01, 0x51, 0x09, 0x06],
    '!': [0x00, 0x00, 0x5f, 0x00, 0x00],
    '#': [0x14, 0x7f, 0x14, 0x7f, 0x14],
    '&': [0x36, 0x49, 0x56, 0x20, 0x50],
    '(': [0x00, 0x1c, 0x22, 0x41, 0x00],
    ')': [0x00, 0x41, 0x22, 0x1c, 0x00],
    '*': [0x08, 0x2a, 0x1c, 0x2a, 0x08],
    '[': [0x00, 0x7f, 0x41, 0x41, 0x00],
    ']': [0x00, 0x41, 0x41, 0x7f, 0x00],
    '_': [0x40, 0x40, 0x40, 0x40, 0x40],
    "'": [0x00, 0x05, 0x03, 0x00, 0x00],
    '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
    '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
    '2': [0x42, 0x61, 0x51, 0x49, 0x46],
    '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
    '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
    '5': [0x27, 0x45, 0x45, 0x45, 0x39],
    '6': [0x3c, 0x4a, 0x49, 0x49, 0x30],
    '7': [0x01, 0x71, 0x09, 0x05, 0x03],
    '8': [0x36, 0x49, 0x49, 0x49, 0x36],
    '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
    A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
    B: [0x7f, 0x49, 0x49, 0x49, 0x36],
    C: [0x3e, 0x41, 0x41, 0x41, 0x22],
    D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
    E: [0x7f, 0x49, 0x49, 0x49, 0x41],
    F: [0x7f, 0x09, 0x09, 0x09, 0x01],
    G: [0x3e, 0x41, 0x49, 0x49, 0x7a],
    H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
    I: [0x00, 0x41, 0x7f, 0x41, 0x00],
    J: [0x20, 0x40, 0x41, 0x3f, 0x01],
    K: [0x7f, 0x08, 0x14, 0x22, 0x41],
    L: [0x7f, 0x40, 0x40, 0x40, 0x40],
    M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
    N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
    O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
    P: [0x7f, 0x09, 0x09, 0x09, 0x06],
    Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
    R: [0x7f, 0x09, 0x19, 0x29, 0x46],
    S: [0x46, 0x49, 0x49, 0x49, 0x31],
    T: [0x01, 0x01, 0x7f, 0x01, 0x01],
    U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
    V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
    W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
    X: [0x63, 0x14, 0x08, 0x14, 0x63],
    Y: [0x07, 0x08, 0x70, 0x08, 0x07],
    Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  };

  function textPath(ctx, text, x, y, pitch, size, grow) {
    const g0 = grow || 0;
    ctx.beginPath();
    for (let i = 0; i < text.length; i++) {
      const g = FONT[text[i]] || FONT['?'];
      const gx = x + i * 6 * pitch;
      for (let col = 0; col < 5; col++) {
        const bits = g[col];
        if (!bits) continue;
        for (let row = 0; row < 7; row++) {
          if (bits & (1 << row)) ctx.rect(gx + col * pitch - g0, y + row * pitch - g0, size + 2 * g0, size + 2 * g0);
        }
      }
    }
    ctx.fill();
  }

  // Title-line glyphs: the OS font is rasterised into a 16-row bitmap (8 columns for narrow characters, 16 for
  // full-width ones) and thresholded, which is how bitmap fonts on Japanese head units behaved.
  const glyphCache = new Map();
  let rasterCanvas = null;
  let rasterCtx = null;
  const CJK_FONT = '15px "Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans CJK JP","Noto Sans JP","PingFang SC","Apple SD Gothic Neo",sans-serif';
  const LATIN_FONT = '13px "SF Mono",Menlo,Monaco,Consolas,"DejaVu Sans Mono",monospace';

  function isWide(cp) {
    return (
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
    );
  }

  function glyphBitmap(ch) {
    let gl = glyphCache.get(ch);
    if (gl) return gl;
    const cp = ch.codePointAt(0);
    const w = isWide(cp) ? 16 : 8;
    const rows = new Array(TITLE_ROWS).fill(0);
    if (cp > 0x20 && cp !== 0x3000 && cp !== 0xa0) {
      if (!rasterCanvas) {
        rasterCanvas = document.createElement('canvas');
        rasterCtx = rasterCanvas.getContext('2d', { willReadFrequently: true });
      }
      rasterCanvas.width = w; // also resets the context state
      rasterCanvas.height = TITLE_ROWS;
      const g = rasterCtx;
      g.fillStyle = '#fff';
      g.textBaseline = 'alphabetic';
      if (w === 16) {
        g.font = CJK_FONT;
        g.fillText(ch, 0.5, 13.2);
      } else {
        g.font = LATIN_FONT;
        const mw = g.measureText(ch).width;
        if (mw > w - 0.5) g.scale((w - 0.5) / mw, 1);
        g.fillText(ch, 0, 12.2);
      }
      const px = g.getImageData(0, 0, w, TITLE_ROWS).data;
      for (let y = 0; y < TITLE_ROWS; y++) {
        let bits = 0;
        for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 96) bits |= 1 << x;
        rows[y] = bits;
      }
    }
    gl = { w, rows };
    glyphCache.set(ch, gl);
    return gl;
  }

  // Adds a rounded rectangle sub-path (no beginPath, so many can be batched into one fill).
  function addRoundRect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r === 0) {
      g.rect(x, y, w, h);
      return;
    }
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // Dot text with a cheap soft glow: two faint, fatter passes under the crisp dots. (Canvas shadowBlur gave a
  // nicer bloom but cost ~40% of the frame.)
  function glowText(ctx, rgb, a, text, x, y, pitch, size) {
    ctx.fillStyle = 'rgba(' + rgb + ',' + (a * 0.07).toFixed(3) + ')';
    textPath(ctx, text, x, y, pitch, size, 2.6);
    ctx.fillStyle = 'rgba(' + rgb + ',' + (a * 0.17).toFixed(3) + ')';
    textPath(ctx, text, x, y, pitch, size, 1.2);
    ctx.fillStyle = 'rgba(' + rgb + ',' + a.toFixed(3) + ')';
    textPath(ctx, text, x, y, pitch, size, 0);
  }

  function gridPath(ctx, cells, x, y, pitch, size) {
    ctx.beginPath();
    for (let i = 0; i < cells; i++) {
      for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 7; row++) {
          ctx.rect(x + i * 6 * pitch + col * pitch, y + row * pitch, size, size);
        }
      }
    }
    ctx.fill();
  }

  // ---- power-on opening ---------------------------------------------------------------------------
  // One timeline (seconds after the POWER key) shared by the display, the panel lighting and the sound
  // (AudioEngine.playOpening reads the same table, so a letter lighting up and its note are the same instant).
  //   check      two strobes of every segment (the first is dim: the phosphor is still warming up)
  //   line/band  a hairline of light draws out from the centre and swells into a band
  //   letters    VFD-5000 ignites one character at a time, white-hot, cooling to the display colour
  //   subtitle   DIGITAL SPECTRUM ANALYZER tracks out from tight to wide; a slit of light sweeps the logo
  //   impact     the band snaps shut, the whole display flares, and every bar erupts left to right
  //   finale     the bars fall as a curtain, HELLO is typed, the annunciators run, WELCOME is wiped in
  const OPENING = {
    total: 5.6,
    testStart: 0.14, testEnd: 0.64,
    checkOn: (t) => (t >= 0.14 && t < 0.3) || (t >= 0.38 && t < 0.64),
    lineStart: 0.72, lineEnd: 1.04, // the line of light ...
    irisEnd: 1.5, // ... swells into the band that carries the logo
    letterStart: 1.5, letterGap: 0.11, // 8 characters: the last one lights at 2.27
    subStart: 1.95, subEnd: 2.75,
    glintStart: 2.4, glintEnd: 3.05, // a bright slit sweeps across the finished logo
    collapseStart: 3.15, collapseEnd: 3.48, // the band closes back into the line
    flashAt: 3.5, // impact
    sweepStart: 3.55, sweepSpan: 0.6, // the eruption: each bar shoots up in turn
    fallStart: 4.5, fallSpan: 0.4, // ... and falls away as a curtain
    helloStart: 4.5, // HELLO is typed with a block cursor
    annStart: 4.6, // the annunciators run a light along the bottom edge
    titleStart: 4.75, // WELCOME is wiped onto the title line
  };
  const LOGO_TEXT = 'VFD-5000';
  const LOGO_SUB = 'DIGITAL SPECTRUM ANALYZER';
  const LOGO_PITCH = 10;
  const LOGO_SIZE = 8.6;
  const SUB_PITCH = 3.6;
  const SUB_SIZE = 2.9;
  const BAND_H = 148;

  const ease3 = (u) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
  const clamp01 = (u) => Math.min(1, Math.max(0, u));
  const hump = (p, rise, fall) => (p <= 0 ? 0 : p < rise ? p / rise : Math.max(0, 1 - (p - rise) / fall));
  // a stable pseudo-random number for particle k (no state, so any frame can be drawn on its own)
  const rnd = (k, salt) => {
    const v = Math.sin(k * 127.1 + salt * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  // the display colour pushed toward white: the "white-hot" of a fresh ignition
  const paleRgb = (c, k) => c.map((v) => Math.round(v + (255 - v) * k)).join(',');

  // Bar levels (0..1) for the opening: all lit for the display check, silent while the logo is up, then the eruption
  // (each bar shoots up in turn, left to right, and shimmers), and finally the curtain fall.
  function openingLevels(t, n, out) {
    const O = OPENING;
    if (O.checkOn(t)) {
      for (let i = 0; i < n; i++) out[i] = 1;
      return;
    }
    for (let i = 0; i < n; i++) out[i] = 0;
    const u = t - O.sweepStart;
    if (u < 0) return;
    for (let i = 0; i < n; i++) {
      const x = n > 1 ? i / (n - 1) : 0.5;
      const rise = ease3((u - x * O.sweepSpan) / 0.16);
      const fall = Math.pow(clamp01((t - O.fallStart - (1 - x) * O.fallSpan) / 0.5), 2);
      // once up, the bars dance like a real signal (each at its own phase) instead of standing as a wall
      const dance = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * 13 + i * 2.3));
      const settle = ease3((u - x * O.sweepSpan - 0.16) / 0.25);
      out[i] = rise * (1 - fall) * (1 - settle * (1 - dance));
    }
  }

  // the display-wide flare at the impact (0..1)
  const openingFlash = (t) => hump(t - OPENING.flashAt, 0.05, 0.32);
  // how much light the display throws onto the bezel during the opening (0..1)
  function openingGlow(t) {
    const O = OPENING;
    let g = 0;
    if (t >= O.lineStart) g = 0.12 + 0.16 * ease3((t - O.lineStart) / (O.irisEnd - O.lineStart));
    if (t >= O.glintStart) g += 0.2 * hump(t - O.glintStart, 0.3, 0.5);
    if (t >= O.collapseEnd) g = Math.max(g * 0.5, 0);
    return Math.min(1, Math.max(g, openingFlash(t)));
  }

  // Phosphor colour themes. Every theme: normal zone (lo -> hi) for the bottom 80%, then the clipping zone
  // (warn -> hot) for the top 20%. `illum` is the panel's key backlight colour.
  const THEMES = [
    { id: 'CYAN', lo: [0, 240, 188], hi: [30, 255, 212], warn: [255, 176, 0], hot: [255, 60, 30], text: [0, 255, 204], unlit: [150, 210, 185], bg: ['#061511', '#010504'], illum: [255, 168, 60] },
    { id: 'GREEN', lo: [60, 255, 80], hi: [150, 255, 110], warn: [255, 200, 0], hot: [255, 70, 30], text: [110, 255, 110], unlit: [160, 220, 160], bg: ['#08160a', '#020503'], illum: [120, 255, 110] },
    { id: 'AMBER', lo: [255, 168, 0], hi: [255, 205, 70], warn: [255, 110, 0], hot: [255, 40, 20], text: [255, 176, 0], unlit: [220, 170, 110], bg: ['#170d04', '#050301'], illum: [255, 150, 30] },
    { id: 'ICE', lo: [110, 185, 255], hi: [190, 235, 255], warn: [255, 190, 90], hot: [255, 90, 90], text: [150, 215, 255], unlit: [150, 185, 220], bg: ['#060d17', '#010305'], illum: [110, 185, 255] },
    { id: 'ROSE', lo: [255, 90, 165], hi: [255, 150, 215], warn: [255, 195, 60], hot: [255, 60, 40], text: [255, 125, 195], unlit: [220, 160, 190], bg: ['#170811', '#050203'], illum: [255, 95, 165] },
    { id: 'VIOLET', lo: [150, 70, 255], hi: [205, 150, 255], warn: [255, 120, 205], hot: [255, 70, 90], text: [190, 125, 255], unlit: [190, 150, 235], bg: ['#0d0619', '#030108'], illum: [176, 104, 255] },
    { id: 'CROSS', lo: [50, 105, 255], hi: [130, 180, 255], warn: [225, 235, 255], hot: [255, 255, 255], text: [125, 172, 255], unlit: [150, 170, 235], bg: ['#040a1d', '#010208'], illum: [96, 146, 255] },
  ];

  function lerpRgb(a, b, t) {
    return a.map((v, i) => Math.round(v + (b[i] - v) * t));
  }

  // h 0..360, s and l 0..1 -> [r, g, b] 0..255
  function hslRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
  }

  const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

  // A phosphor theme built from one hue. Warm hues would lose the amber/red clipping zone, so those go pale and then
  // white-hot instead. `s` (0..1) is the vividness; s = 0 gives a white display.
  function hueTheme(id, h, s = 1, opt = {}) {
    const warm = opt.warm !== undefined ? opt.warm : h >= 338 || h < 58;
    return {
      id,
      lo: hslRgb(h, s, 0.5),
      hi: hslRgb(h, s * 0.9, 0.72),
      warn: warm ? hslRgb(h, 0.5 * s, 0.86) : [255, 176, 0],
      hot: warm ? [255, 255, 255] : [255, 64, 40],
      text: hslRgb(h, s, 0.62),
      unlit: hslRgb(h, 0.35 + 0.1 * s, 0.75),
      bg: [hex(hslRgb(h, 0.5 * s + 0.05, 0.075)), hex(hslRgb(h, 0.45 * s + 0.05, 0.02))],
      illum: hslRgb(h, s, 0.62),
    };
  }

  // A multi-colour theme: the colour runs up the bar through `stops` ([position 0..1, rgb]); `rainbow` instead gives
  // each column its own hue (h0 + span across the columns).
  function stopTheme(id, stops, text, bg, extra) {
    return Object.assign({ id, stops, lo: stops[0][1], hi: stops[stops.length - 1][1], warn: stops[stops.length - 2][1], hot: stops[stops.length - 1][1], text, unlit: lerpRgb(text, [190, 195, 205], 0.55), bg, illum: text }, extra || {});
  }

  THEMES.push(
    hueTheme('RED', 2),
    hueTheme('ORANGE', 24),
    hueTheme('YELLOW', 54),
    hueTheme('LIME', 84),
    hueTheme('MINT', 150),
    hueTheme('SKY', 198),
    hueTheme('BLUE', 226),
    hueTheme('INDIGO', 252),
    hueTheme('MAGENTA', 300),
    { id: 'WHITE', lo: [215, 225, 240], hi: [255, 255, 255], warn: [255, 176, 0], hot: [255, 64, 40], text: [235, 240, 250], unlit: [200, 205, 215], bg: ['#0b0c0e', '#020203'], illum: [236, 242, 255] },
    stopTheme('RAINBOW', [[0, [255, 60, 60]], [0.2, [255, 200, 30]], [0.4, [90, 255, 80]], [0.6, [40, 220, 255]], [0.8, [120, 110, 255]], [1, [255, 255, 255]]], [200, 220, 255], ['#0a0a12', '#020204'], { rainbow: { h0: 0, span: 290 } }),
    stopTheme('SPECTRUM', [[0, [30, 90, 255]], [0.25, [0, 220, 255]], [0.5, [40, 255, 90]], [0.72, [255, 230, 0]], [0.88, [255, 120, 0]], [1, [255, 30, 20]]], [110, 230, 255], ['#050c16', '#010306']),
    stopTheme('SUNSET', [[0, [120, 40, 220]], [0.35, [240, 60, 170]], [0.65, [255, 120, 60]], [1, [255, 225, 120]]], [255, 150, 130], ['#14070f', '#040104']),
    stopTheme('OCEAN', [[0, [10, 60, 200]], [0.5, [0, 170, 255]], [0.85, [120, 240, 255]], [1, [240, 255, 255]]], [90, 200, 255], ['#040b18', '#010306']),
    stopTheme('FIRE', [[0, [190, 20, 10]], [0.4, [255, 90, 0]], [0.75, [255, 190, 20]], [1, [255, 255, 220]]], [255, 130, 40], ['#180603', '#050201']),
    stopTheme('AURORA', [[0, [30, 200, 120]], [0.5, [0, 230, 220]], [0.8, [140, 120, 255]], [1, [230, 160, 255]]], [90, 240, 200], ['#04120f', '#010504']),
    stopTheme('NEON', [[0, [255, 40, 200]], [0.5, [120, 80, 255]], [1, [0, 240, 255]]], [255, 100, 230], ['#0d0416', '#030106']),
    hueTheme('CUSTOM', 200) // the last slot: rebuilt from the hue / vividness sliders
  );

  function zoneRgb(theme, f) {
    const st = theme.stops;
    if (st) {
      if (f <= st[0][0]) return st[0][1];
      for (let i = 1; i < st.length; i++) {
        if (f <= st[i][0]) return lerpRgb(st[i - 1][1], st[i][1], (f - st[i - 1][0]) / (st[i][0] - st[i - 1][0]));
      }
      return st[st.length - 1][1];
    }
    return f <= 0.8 ? lerpRgb(theme.lo, theme.hi, (f / 0.8) * 0.55) : lerpRgb(theme.warn, theme.hot, (f - 0.8) / 0.2);
  }

  function rowPrefixes(theme, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('rgba(' + zoneRgb(theme, (i + 0.5) / n).join(',') + ',');
    return out;
  }

  const ROW_Y = [];
  for (let r = 0; r < ROWS; r++) ROW_Y.push(SPEC_TOP + SPEC_H - (r + 1) * PITCH_Y + GAP_Y);

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // 3-tap box blur (horizontal then vertical) of a small canvas, in place. 'lighter' with 1/3 alpha is a true
  // average; without it a 2x2 box down-sample never bleeds past its own texel and the halo has no tail.
  function smear(m) {
    const w = m.c.width;
    const h = m.c.height;
    const t = m.tctx;
    t.globalCompositeOperation = 'source-over';
    t.globalAlpha = 1;
    t.clearRect(0, 0, w, h);
    t.globalCompositeOperation = 'lighter';
    t.globalAlpha = 1 / 3;
    t.drawImage(m.c, -1, 0);
    t.drawImage(m.c, 0, 0);
    t.drawImage(m.c, 1, 0);
    const d = m.ctx;
    d.globalCompositeOperation = 'source-over';
    d.globalAlpha = 1;
    d.clearRect(0, 0, w, h);
    d.globalCompositeOperation = 'lighter';
    d.globalAlpha = 1 / 3;
    d.drawImage(m.tmp, 0, -1);
    d.drawImage(m.tmp, 0, 0);
    d.drawImage(m.tmp, 0, 1);
    d.globalAlpha = 1;
    d.globalCompositeOperation = 'source-over';
  }

  function fmtDb(p) {
    return p < 0.005 ? '-INF' : (p * 60 - 60).toFixed(1);
  }

  // Segment brightness follows its target instantly upward and decays through the phosphor afterglow downward.
  function follow(prev, target, rel) {
    return target >= prev ? target : Math.max(target, prev > 0.02 ? prev * rel : 0);
  }

  // Real phosphor is never perfectly even: each segment has its own efficiency and the plate is a little
  // dimmer toward its edges. Deterministic per position, so a segment keeps its character.
  function phosphorGain(x, y) {
    const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const j = h - Math.floor(h);
    const dx = (x - W / 2) / (W / 2);
    const dy = (y - H / 2) / (H / 2);
    return Math.min(1, ((0.9 + 0.1 * j) * (1 - 0.11 * (dx * dx * 0.75 + dy * dy * 0.25))) / 0.96);
  }

  // 7-segment digit outlines in digit-local coordinates (before slant). Bit order: a b c d e f g.
  const SEG7_POLYS = (function () {
    const Wd = D7_W;
    const Hd = D7_H;
    const T = D7_T;
    const G = D7_G;
    const h = T / 2;
    const top = [[h + G, h], [T + G, 0], [Wd - T - G, 0], [Wd - h - G, h], [Wd - T - G, T], [T + G, T]];
    const upperLeft = [[h, h + G], [T, T + G], [T, Hd / 2 - h - G], [h, Hd / 2 - G], [0, Hd / 2 - h - G], [0, T + G]];
    const mid = [[h + G, Hd / 2], [T + G, Hd / 2 - h], [Wd - T - G, Hd / 2 - h], [Wd - h - G, Hd / 2], [Wd - T - G, Hd / 2 + h], [T + G, Hd / 2 + h]];
    const my = (poly) => poly.map(([x, y]) => [x, Hd - y]);
    const mx = (poly) => poly.map(([x, y]) => [Wd - x, y]);
    return [top, mx(upperLeft), mx(my(upperLeft)), my(top), my(upperLeft), upperLeft, mid];
  })();
  const SEG7_MAP = { '0': 0x3f, '1': 0x06, '2': 0x5b, '3': 0x4f, '4': 0x66, '5': 0x6d, '6': 0x7d, '7': 0x07, '8': 0x7f, '9': 0x6f, ' ': 0 };

  function digitPath(ctx, x, y, mask) {
    for (let i = 0; i < 7; i++) {
      if (!(mask & (1 << i))) continue;
      const poly = SEG7_POLYS[i];
      for (let k = 0; k < poly.length; k++) {
        const px = x + poly[k][0] + (D7_H - poly[k][1]) * D7_SLANT;
        const py = y + poly[k][1];
        if (k) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
    }
  }

  function colonRects(ctx, y) {
    for (const f of [0.3, 0.7]) {
      const py = y + D7_H * f - 6.5;
      ctx.rect(COLON_X - 6.5 + (D7_H - D7_H * f) * D7_SLANT, py, 13, 13);
    }
  }

  function annShape(ctx, it, rgb, a, renderer) {
    if (it.icon === 'play') {
      ctx.beginPath();
      ctx.moveTo(it.x, ANN_Y);
      ctx.lineTo(it.x + 11, ANN_Y + 7);
      ctx.lineTo(it.x, ANN_Y + 14);
      ctx.closePath();
      ctx.fill();
    } else if (it.icon === 'pause') {
      ctx.fillRect(it.x, ANN_Y, 4.4, 14);
      ctx.fillRect(it.x + 7.6, ANN_Y, 4.4, 14);
    } else if (renderer) {
      renderer._text(ctx, rgb, a, it.text, it.x, ANN_Y, ANN_PITCH, ANN_PITCH, true);
    } else {
      textPath(ctx, it.text, it.x, ANN_Y, ANN_PITCH, ANN_PITCH);
    }
  }

  class VfdRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.layout = { kind: 'bars', bandCount: 15, mirror: false, labels: [] };
      this.kind = 'bars';
      this.cols = [];
      this.fan = null;
      this.cellSeg = new Float32Array(0);
      this.scopePeak = 0.05;
      this.seg = new Float32Array(0);
      this.levelSeg = new Float32Array(2 * LV_SEGS);
      this.secSeg = new Float32Array(SEC_SEGS);
      this.annSeg = new Float32Array(ANN_ITEMS.length);
      this.osdSeg = new Float32Array(OSD_SEGS);
      this.segGain = new Float32Array(0);
      this.lvGain = new Float32Array(2 * LV_SEGS);
      for (let ch = 0; ch < 2; ch++) {
        for (let i = 0; i < LV_SEGS; i++) this.lvGain[ch * LV_SEGS + i] = phosphorGain(LV_X0 + i * LV_PITCH + LV_SEGW / 2, LV_Y[ch] + LV_H / 2);
      }
      this.scale = 1;
      this.pxW = 0;
      this.pxH = 0;
      this.sprites = new Map();
      this.textCache = new Map();
      this.titleCache = new Map();
      this.parX = 0;
      this.parY = 0;
      this.haloBoost = 1;
      this.heat = 0;
      this.theme = THEMES[0];
      this.rbCache = new Map();
      this.rowPrefix = rowPrefixes(this.theme, ROWS);
      this.lvPrefix = rowPrefixes(this.theme, LV_SEGS);
      this.osdPrefix = rowPrefixes(this.theme, OSD_SEGS);
      this.resize(W, 1);
    }

    setTheme(theme) {
      this.theme = theme;
      this.rowPrefix = rowPrefixes(theme, ROWS);
      this.lvPrefix = rowPrefixes(theme, LV_SEGS);
      this.osdPrefix = rowPrefixes(theme, OSD_SEGS);
      this.rbCache.clear();
      this.sprites.clear();
      this.textCache.clear();
      this.titleCache.clear();
      this._drawUnlit();
    }

    // The physical layers that sit in front of the phosphor: wire mesh, heater filaments, glass grain. They float
    // above the phosphor plane, so the overlay is built oversized and drawn shifted with the viewer's angle
    // (parallax). Built once per size; one drawImage per frame.
    _buildOverlay() {
      const { pxW, pxH, scale: S } = this;
      const M = Math.ceil(5 * S);
      const w = pxW + 2 * M;
      const h = pxH + 2 * M;
      this.overlayM = M;
      const c = makeCanvas(w, h);
      const o = c.getContext('2d');

      const img = o.createImageData(w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random();
        if (v < 0.5) {
          d[i + 3] = (0.5 - v) * 2 * 16;
        } else {
          d[i] = d[i + 1] = d[i + 2] = 255;
          d[i + 3] = (v - 0.5) * 2 * 7;
        }
      }
      o.putImageData(img, 0, 0);

      const t = Math.max(3, Math.round(2 * S));
      const tile = makeCanvas(t, t);
      const tc = tile.getContext('2d');
      tc.fillStyle = 'rgba(0,0,0,0.10)';
      tc.fillRect(t - 1, 0, 1, t);
      tc.fillRect(0, t - 1, t, 1);
      o.fillStyle = o.createPattern(tile, 'repeat');
      o.fillRect(0, 0, w, h);

      const glow = makeCanvas(w, h);
      const gc = glow.getContext('2d');
      for (const fy of [0.3, 0.71]) {
        const y = M + Math.round(pxH * fy);
        // the heater wire glows dull orange when powered: a wide faint halo and a thin hot core
        for (const [lw, al] of [[S * 4.5, 0.05], [S * 2, 0.1], [Math.max(1, S * 0.7), 0.55]]) {
          gc.strokeStyle = 'rgba(255,120,45,' + al + ')';
          gc.lineWidth = lw;
          gc.beginPath();
          gc.moveTo(0, y);
          gc.quadraticCurveTo(w / 2, y + 2.2 * S, w, y);
          gc.stroke();
        }
        // spring anchors at both ends of the wire
        for (const ax of [M + 5 * S, w - M - 5 * S]) {
          o.fillStyle = 'rgba(0,0,0,0.5)';
          o.fillRect(ax - 0.6 * S, y - 5 * S, 1.2 * S, 10 * S);
          gc.fillStyle = 'rgba(255,140,60,0.5)';
          gc.fillRect(ax - 1.1 * S, y - 1.1 * S, 2.2 * S, 2.2 * S);
        }
        o.strokeStyle = 'rgba(0,0,0,0.34)';
        o.lineWidth = Math.max(1, S * 0.55);
        o.beginPath();
        o.moveTo(0, y);
        o.quadraticCurveTo(w / 2, y + 2.2 * S, w, y);
        o.stroke();
        o.strokeStyle = 'rgba(255,255,255,0.05)';
        o.beginPath();
        o.moveTo(0, y + Math.max(1, S * 0.7));
        o.quadraticCurveTo(w / 2, y + 2.2 * S + Math.max(1, S * 0.7), w, y + Math.max(1, S * 0.7));
        o.stroke();
      }
      this.overlay = c;
      this.filamentGlow = glow;
      this.filamentBands = [0.3, 0.71].map((fy) => {
        const y = M + Math.round(pxH * fy);
        const half = Math.ceil(8 * S);
        return { y: Math.max(0, y - half), h: Math.min(h, y + half) - Math.max(0, y - half) };
      });
    }

    // cssWidth: displayed width in CSS px; dpr: device pixel ratio.
    resize(cssWidth, dpr) {
      const pw = Math.max(480, Math.min(1800, Math.round(cssWidth * dpr)));
      if (pw === this.pxW) return;
      this.pxW = pw;
      this.pxH = Math.round((pw * H) / W);
      this.scale = pw / W;
      this.sprites.clear();
      this.textCache.clear();
      this.titleCache.clear();
      this.canvas.width = this.pxW;
      this.canvas.height = this.pxH;

      this.unlit = makeCanvas(this.pxW, this.pxH);
      this.lit = makeCanvas(this.pxW, this.pxH);
      this.litCtx = this.lit.getContext('2d');
      this.mips = HALO_DIVISORS.map((d, i) => {
        const w = Math.max(1, Math.ceil(this.pxW / d));
        const h = Math.max(1, Math.ceil(this.pxH / d));
        const c = makeCanvas(w, h);
        const tmp = makeCanvas(w, h);
        const acc = makeCanvas(w, h);
        return { c, ctx: c.getContext('2d'), tmp, tctx: tmp.getContext('2d'), acc, actx: acc.getContext('2d'), w, h, smears: HALO_SMEARS[i] };
      });
      this._buildOverlay();
      this._drawUnlit();
    }

    // spec: { kind: 'bars'|'eq'|'level'|'clock', bandCount, mirror, labels }
    setLayout(spec) {
      this.layout = spec;
      this.kind = spec.kind || 'bars';
      this.cols = [];
      this.fan = null;
      if (this.kind === 'bars' && spec.fan) {
        const n = spec.bandCount;
        const p0 = FAN_BASE_SPAN / n;
        const barW0 = Math.min(p0 * 0.86, MAX_BAR_W * 0.8);
        const yBase = SPEC_TOP + SPEC_H;
        this.fan = { barW0, sc: ROW_Y.map((y) => 1 + (FAN_TOP_SCALE - 1) * ((yBase - (y + SEG_H / 2)) / SPEC_H)) };
        for (let c = 0; c < n; c++) {
          const off = (c - (n - 1) / 2) * p0;
          this.cols.push({ band: c, x: W / 2 + off - barW0 / 2, w: barW0, pitch: p0, off, k: (-off * (FAN_TOP_SCALE - 1)) / SPEC_H });
        }
        this.seg = new Float32Array(n * ROWS);
        this.segGain = new Float32Array(n * ROWS);
        this.cellSeg = new Float32Array(n);
        for (let c = 0; c < n; c++) {
          for (let r = 0; r < ROWS; r++) this.segGain[c * ROWS + r] = phosphorGain(W / 2 + this.cols[c].off * this.fan.sc[r], ROW_Y[r] + SEG_H / 2);
        }
      } else if (this.kind === 'scope') {
        this.seg = new Float32Array(SC_COLS * ROWS);
        this.segGain = new Float32Array(SC_COLS * ROWS);
        for (let c = 0; c < SC_COLS; c++) {
          for (let r = 0; r < ROWS; r++) this.segGain[c * ROWS + r] = phosphorGain(PAD_X + c * SC_PITCH + SC_W / 2, ROW_Y[r] + SEG_H / 2);
        }
      } else if (this.kind === 'bars' || this.kind === 'eq') {
        const count = spec.mirror ? spec.bandCount * 2 : spec.bandCount;
        const inner = W - PAD_X * 2;
        const pitch = inner / count;
        const gap = Math.max(3, pitch * 0.13);
        const barW = Math.min(pitch - gap, MAX_BAR_W);
        for (let c = 0; c < count; c++) {
          const band = c < spec.bandCount ? c : count - 1 - c;
          this.cols.push({ band, x: PAD_X + c * pitch + (pitch - barW) / 2, w: barW, pitch });
        }
        this.seg = new Float32Array(count * ROWS);
        this.segGain = new Float32Array(count * ROWS);
        for (let c = 0; c < count; c++) {
          for (let r = 0; r < ROWS; r++) this.segGain[c * ROWS + r] = phosphorGain(this.cols[c].x + this.cols[c].w / 2, ROW_Y[r] + SEG_H / 2);
        }
      }
      this.levelSeg.fill(0);
      this.secSeg.fill(0);
      this.osdSeg.fill(0);
      this._drawUnlit();
    }

    _drawUnlit() {
      const u = this.unlit.getContext('2d');
      const S = this.scale;
      u.setTransform(1, 0, 0, 1, 0, 0);
      const bg = u.createRadialGradient(this.pxW / 2, this.pxH * 0.45, this.pxH * 0.1, this.pxW / 2, this.pxH * 0.5, this.pxW * 0.62);
      bg.addColorStop(0, this.theme.bg[0]);
      bg.addColorStop(1, this.theme.bg[1]);
      u.fillStyle = bg;
      u.fillRect(0, 0, this.pxW, this.pxH);

      u.setTransform(S, 0, 0, S, 0, 0);
      u.fillStyle = 'rgba(' + this.theme.unlit.join(',') + ',' + UNLIT_ALPHA + ')';

      if (this.fan) {
        const fan = this.fan;
        u.beginPath();
        for (const col of this.cols) {
          for (let r = 0; r < ROWS; r++) {
            const cx = W / 2 + col.off * fan.sc[r];
            const hw = (fan.barW0 * fan.sc[r]) / 2;
            const dx = col.k * (SEG_H / 2);
            u.moveTo(cx - hw - dx, ROW_Y[r]);
            u.lineTo(cx + hw - dx, ROW_Y[r]);
            u.lineTo(cx + hw + dx, ROW_Y[r] + SEG_H);
            u.lineTo(cx - hw + dx, ROW_Y[r] + SEG_H);
            u.closePath();
          }
          u.rect(col.x, FAN_CELL_Y, col.w, FAN_CELL_H);
        }
        u.fill();
        gridPath(u, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        gridPath(u, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
      } else if (this.kind === 'bars' || this.kind === 'eq') {
        u.beginPath();
        for (const col of this.cols) {
          for (let r = 0; r < ROWS; r++) u.rect(col.x, ROW_Y[r], col.w, SEG_H);
        }
        u.fill();
        gridPath(u, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        gridPath(u, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
      } else if (this.kind === 'scope') {
        u.beginPath();
        for (let c = 0; c < SC_COLS; c++) {
          for (let r = 0; r < ROWS; r++) u.rect(PAD_X + c * SC_PITCH + (SC_PITCH - SC_W) / 2, ROW_Y[r], SC_W, SEG_H);
        }
        u.fill();
        gridPath(u, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        gridPath(u, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
      } else if (this.kind === 'level') {
        u.beginPath();
        for (let ch = 0; ch < 2; ch++) {
          for (let i = 0; i < LV_SEGS; i++) u.rect(LV_X0 + i * LV_PITCH, LV_Y[ch], LV_SEGW, LV_H);
        }
        u.fill();
        gridPath(u, 1, 44, LV_Y[0] + (LV_H - 42) / 2, LV_CH_PITCH, LV_CH_SIZE);
        gridPath(u, 1, 44, LV_Y[1] + (LV_H - 42) / 2, LV_CH_PITCH, LV_CH_SIZE);
        gridPath(u, LV_READ_CELLS, (W - (LV_READ_CELLS * 6 * LV_READ_PITCH - LV_READ_PITCH)) / 2, LV_READ_Y, LV_READ_PITCH, LV_READ_SIZE);
        gridPath(u, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        gridPath(u, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
      } else if (this.kind === 'osd') {
        u.beginPath();
        for (const dx of OSD_DIGIT_X) digitPath(u, dx, D7_Y, 0x7f);
        for (let i = 0; i < OSD_SEGS; i++) u.rect(OSD_BAR_X + i * OSD_BAR_PITCH, OSD_BAR_Y, 18, 30);
        u.fill();
        gridPath(u, 4, OSD_LABEL_X, OSD_LABEL_Y, OSD_LABEL_PITCH, OSD_LABEL_SIZE);
        gridPath(u, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        gridPath(u, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
      } else {
        u.beginPath();
        for (const dx of D7_XS) digitPath(u, dx, D7_Y, 0x7f);
        colonRects(u, D7_Y);
        u.fill();
        gridPath(u, DATE_CELLS, DATE_X, DATE_Y, DATE_PITCH, DATE_SIZE);
        u.beginPath();
        for (let i = 0; i < SEC_SEGS; i++) u.rect(SEC_X + i * SEC_PITCH, SEC_Y, 10, 10);
        u.fill();
        gridPath(u, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        gridPath(u, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
      }
      if (this.kind === 'bars' || this.kind === 'eq' || this.kind === 'level' || this.kind === 'scope') {
        u.beginPath();
        for (let r = 0; r < TITLE_ROWS; r++) {
          for (let c = 0; c < TITLE_COLS; c++) u.rect(PAD_X + c * TITLE_PITCH, TITLE_Y + r * TITLE_PITCH, TITLE_SIZE, TITLE_SIZE);
        }
        u.fill();
      }
      for (const it of ANN_ITEMS) annShape(u, it);
    }

    // Maps a pointer position (0..1 across the canvas) to an EQ band and a whole-dB gain (+-12).
    eqHit(nx, ny) {
      if (this.kind !== 'eq' || !this.cols.length) return null;
      const lx = nx * W;
      const ly = ny * H;
      let band = Math.floor((lx - PAD_X) / this.cols[0].pitch);
      band = Math.min(this.cols.length - 1, Math.max(0, band));
      const centerY = SPEC_TOP + SPEC_H / 2;
      const gain = Math.round(((centerY - ly) / (SPEC_H / 2)) * 12);
      return { band, gain: Math.min(12, Math.max(-12, gain)) };
    }

    _drawLabels(lctx, gain) {
      const { bandCount, mirror, labels } = this.layout;
      if (!labels || !labels.length || !this.cols.length) return;
      let maxLen = 0;
      for (const l of labels) maxLen = Math.max(maxLen, l.length);
      const maxW = maxLen * 6 * LABEL_PITCH;
      const step = Math.max(1, Math.ceil((maxW + 4) / this.cols[0].pitch));
      const labelRgb = this.theme.text.join(',');
      const n = this.cols.length;
      for (let c = 0; c < n; c++) {
        const idx = mirror && c >= bandCount ? n - 1 - c : c;
        if (idx % step) continue;
        const col = this.cols[c];
        let cx = col.x + col.w / 2;
        if (mirror && idx === bandCount - 1) {
          // the two centre columns share one label, drawn on their common boundary
          if (c !== idx) continue;
          const next = this.cols[c + 1];
          cx = (cx + next.x + next.w / 2) / 2;
        }
        const text = labels[col.band];
        const tw = text.length * 6 * LABEL_PITCH - LABEL_PITCH;
        this._text(lctx, labelRgb, 0.55 * gain, text, Math.round(cx - tw / 2), LABEL_Y + (this.fan ? 15 : 0), LABEL_PITCH, LABEL_SIZE);
      }
    }

    _drawStatus(lctx, ui, flicker) {
      const left = (ui.leftText || '').toUpperCase();
      const right = (ui.rightText || '').toUpperCase();
      const leftRgb = (ui.amber ? this.theme.warn : this.theme.text).join(',');
      const leftA = ui.amber ? 0.95 * flicker : 0.92 * flicker;
      if (ui.leftScroll > 0) {
        // long text scrolls one dot column at a time, clipped to the field, as on the real display
        lctx.save();
        lctx.beginPath();
        lctx.rect(PAD_X - 2, STATUS_Y - 4, LEFT_CELLS * CHAR_W - DOT_PITCH + 4, 7 * DOT_PITCH + 8);
        lctx.clip();
        this._text(lctx, leftRgb, leftA, left, PAD_X - ui.leftScroll * DOT_PITCH, STATUS_Y, DOT_PITCH, DOT_SIZE);
        lctx.restore();
      } else {
        this._text(lctx, leftRgb, leftA, left.slice(0, LEFT_CELLS), PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
      }
      const r = right.slice(-RIGHT_CELLS);
      this._text(lctx, this.theme.text.join(','), 0.92 * flicker, r, RIGHT_X + (RIGHT_CELLS - r.length) * CHAR_W, STATUS_Y, DOT_PITCH, DOT_SIZE);
    }

    // Per-column colours of the RAINBOW theme: table[band][row] = 'rgba(r,g,b,' prefix.
    _rainbowTable(n) {
      let t = this.rbCache.get(n);
      if (t) return t;
      const { h0, span } = this.theme.rainbow;
      t = [];
      for (let c = 0; c < n; c++) {
        const h = h0 + (span * c) / Math.max(1, n - 1);
        const rows = [];
        for (let r = 0; r < ROWS; r++) {
          const f = (r + 0.5) / ROWS;
          const rgb = f <= 0.8 ? hslRgb(h, 1, 0.5 + 0.14 * (f / 0.8)) : lerpRgb(hslRgb(h, 0.7, 0.8), [255, 255, 255], (f - 0.8) / 0.2);
          rows.push('rgba(' + rgb.join(',') + ',');
        }
        t.push(rows);
      }
      this.rbCache.set(n, t);
      return t;
    }

    _drawBars(lctx, model, ui, flicker, rel) {
      const cols = this.cols;
      const seg = this.seg;
      const gains = this.segGain;
      const power = ui.power;
      const peakOnly = ui.mode === 'peak';
      const centre = ui.mode === 'center';
      const rb = this.theme.rainbow ? this._rainbowTable(this.layout.bandCount) : null;
      const half = ROWS / 2;
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const rowPrefix = rb ? rb[col.band] : this.rowPrefix;
        const level = model.bars[col.band];
        const pk = model.peaks[col.band];
        const base = c * ROWS;
        if (centre) {
          // bars grow up and down from the middle line
          const n = power ? Math.round(level * half) : 0;
          const peakD = power && pk > 0.5 / half ? Math.min(half - 1, Math.ceil(pk * half - 1e-6) - 1) : -1;
          for (let r = 0; r < ROWS; r++) {
            const d = r >= half ? r - half : half - 1 - r;
            const b = (seg[base + r] = follow(seg[base + r], d < n || d === peakD ? 1 : 0, rel));
            if (b === 0) continue;
            this._segment(lctx, col.x, ROW_Y[r], col.w, SEG_H, rowPrefix[Math.min(ROWS - 1, 2 * d + 1)], b * flicker * gains[base + r]);
          }
          continue;
        }
        const bar = power && !peakOnly ? Math.round(level * ROWS) : 0;
        const peakSeg = power && pk > 0.5 / ROWS ? Math.min(ROWS - 1, Math.ceil(pk * ROWS - 1e-6) - 1) : -1;
        for (let r = 0; r < ROWS; r++) {
          const b = (seg[base + r] = follow(seg[base + r], r < bar || r === peakSeg ? 1 : 0, rel));
          if (b === 0) continue;
          this._segment(lctx, col.x, ROW_Y[r], col.w, SEG_H, rowPrefix[r], b * flicker * gains[base + r]);
        }
      }
    }

    // PERSPECTIVE pattern: same levels and peak hold as the normal bars, on the fan geometry, plus a row of block
    // cells under the bars whose brightness follows each band's level.
    _drawFan(lctx, model, ui, flicker, rel) {
      const { cols, seg, segGain: gains, fan } = this;
      const rb = this.theme.rainbow ? this._rainbowTable(this.layout.bandCount) : null;
      const power = ui.power;
      const cellPrefix = 'rgba(' + zoneRgb(this.theme, 0.3).join(',') + ',';
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const level = model.bars[col.band];
        const pk = model.peaks[col.band];
        const base = c * ROWS;
        const rowPrefix = rb ? rb[col.band] : this.rowPrefix;
        const bar = power ? Math.round(level * ROWS) : 0;
        const peakSeg = power && pk > 0.5 / ROWS ? Math.min(ROWS - 1, Math.ceil(pk * ROWS - 1e-6) - 1) : -1;
        for (let r = 0; r < ROWS; r++) {
          const b = (seg[base + r] = follow(seg[base + r], r < bar || r === peakSeg ? 1 : 0, rel));
          if (b === 0) continue;
          this._segmentSheared(lctx, W / 2 + col.off * fan.sc[r], ROW_Y[r], fan.barW0 * fan.sc[r], SEG_H, col.k, rowPrefix[r], b * flicker * gains[base + r]);
        }
        const cb = (this.cellSeg[c] = follow(this.cellSeg[c], power ? Math.min(1, level * 1.1) : 0, rel));
        if (cb > 0.02) this._segment(lctx, col.x, FAN_CELL_Y, col.w, FAN_CELL_H, rb ? rb[col.band][5] : cellPrefix, cb * flicker);
      }
    }

    // The power-on scene. Bars and the display check come through the model; everything else is drawn here.
    _drawOpening(lctx, model, ui, flicker, rel) {
      const O = OPENING;
      const t = ui.openT || 0;
      const tc = this.theme.text;
      const rgb = tc.join(',');
      const hot = paleRgb(tc, 0.72); // white-hot: a fresh ignition, before it cools to the display colour
      const cy = SPEC_TOP + SPEC_H / 2;
      const fill = (a) => 'rgba(' + rgb + ',' + Math.min(1, a).toFixed(3) + ')';
      const hotFill = (a) => 'rgba(' + hot + ',' + Math.min(1, Math.max(0, a)).toFixed(3) + ')';

      this._drawBars(lctx, model, ui, flicker, rel);

      // annunciators: all lit for the check, then a short run of light sweeps left to right and leaves the real ones on
      const head = (t - O.annStart) / 0.06;
      for (let i = 0; i < ANN_ITEMS.length; i++) {
        const it = ANN_ITEMS[i];
        const active = !!(ui.ann && ui.ann[it.id]);
        const on = ui.allOn || (t >= O.annStart && ((i <= head && i > head - 3.5) || (i <= head - 3.5 && active)));
        const b = (this.annSeg[i] = follow(this.annSeg[i], on ? 1 : 0, rel));
        if (b === 0) continue;
        lctx.fillStyle = fill(b * flicker * 0.92);
        annShape(lctx, it, rgb, b * flicker * 0.92, this);
      }

      if (ui.allOn) {
        lctx.fillStyle = fill(0.9 * flicker);
        gridPath(lctx, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        gridPath(lctx, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        lctx.fillStyle = fill(0.5 * flicker);
        lctx.beginPath();
        for (let r = 0; r < TITLE_ROWS; r++) {
          for (let c = 0; c < TITLE_COLS; c++) lctx.rect(PAD_X + c * TITLE_PITCH, TITLE_Y + r * TITLE_PITCH, TITLE_SIZE, TITLE_SIZE);
        }
        lctx.fill();
        return;
      }

      // the line of light and the band it swells into
      const fullHalf = W / 2 - PAD_X;
      let half = 0;
      let band = 0;
      if (t >= O.lineStart) {
        half = t < O.lineEnd ? ease3((t - O.lineStart) / (O.lineEnd - O.lineStart)) * fullHalf : fullHalf;
        if (t >= O.lineEnd && t < O.irisEnd) band = ease3((t - O.lineEnd) / (O.irisEnd - O.lineEnd)) * BAND_H;
        else if (t >= O.irisEnd && t < O.collapseStart) band = BAND_H;
        else if (t >= O.collapseStart && t < O.collapseEnd) band = (1 - ease3((t - O.collapseStart) / (O.collapseEnd - O.collapseStart))) * BAND_H;
        if (t >= O.collapseEnd) half *= Math.max(0, 1 - (t - O.collapseEnd) / 0.14);
      }
      if (half > 1 && band <= 6) {
        const a = flicker * 0.95;
        lctx.fillStyle = fill(a * 0.55);
        lctx.fillRect(W / 2 - half, cy - 2.4, half * 2, 4.8);
        lctx.fillStyle = hotFill(a);
        lctx.fillRect(W / 2 - half, cy - 0.8, half * 2, 1.6);
        if (t < O.lineEnd) {
          // the two heads: a white-hot point with a cross-shaped flare that shrinks as they reach the edges
          const k = 1 - (t - O.lineStart) / (O.lineEnd - O.lineStart);
          for (const sx of [W / 2 - half, W / 2 + half]) {
            lctx.fillStyle = 'rgba(255,255,255,' + Math.min(1, 0.95 * flicker).toFixed(3) + ')';
            lctx.fillRect(sx - 2.5, cy - 2.5, 5, 5);
            lctx.fillStyle = hotFill(0.55 * flicker);
            lctx.fillRect(sx - 0.8, cy - 14 - 10 * k, 1.6, 28 + 20 * k);
            lctx.fillRect(sx - 12, cy - 0.8, 24, 1.6);
          }
        }
      }
      // sparks shed by the heads as the line draws out
      if (t >= O.lineStart && t < O.lineEnd + 0.45) {
        const life = 0.42;
        for (let k = 0; k < 22; k++) {
          const te = O.lineStart + (k / 22) * (O.lineEnd - O.lineStart);
          const age = t - te;
          if (age < 0 || age > life) continue;
          const hx = fullHalf * ease3((te - O.lineStart) / (O.lineEnd - O.lineStart));
          const x = W / 2 + (k & 1 ? 1 : -1) * hx + (rnd(k, 1) - 0.5) * 70 * age;
          const y = cy + (rnd(k, 2) - 0.5) * 100 * Math.pow(age, 0.75);
          lctx.fillStyle = hotFill(Math.pow(1 - age / life, 1.6) * flicker);
          lctx.fillRect(x - 1.1, y - 1.1, 2.2, 2.2);
        }
      }

      if (band > 2) {
        const top = cy - band / 2;
        lctx.save();
        lctx.beginPath();
        lctx.rect(PAD_X, top, W - PAD_X * 2, band);
        lctx.clip();
        const breathe = t > O.irisEnd ? 0.94 + 0.06 * Math.sin(t * 9) : 1;
        const adv = 6 * LOGO_PITCH;
        const logoW = (LOGO_TEXT.length * 6 - 1) * LOGO_PITCH + LOGO_SIZE;
        const lx = Math.round((W - logoW) / 2);
        const ly = Math.round(cy - 56);
        const sy = Math.round(cy + 34);

        // VFD-5000 ignites one character at a time: white-hot with a thin flash of light through the band, then it
        // cools to the display colour
        for (let k = 0; k < LOGO_TEXT.length; k++) {
          const p = t - (O.letterStart + k * O.letterGap);
          if (p < 0) continue;
          const ch = LOGO_TEXT[k];
          const cx = lx + k * adv;
          this._text(lctx, rgb, 0.8 * flicker * breathe * ease3(p / 0.05), ch, cx, ly, LOGO_PITCH, LOGO_SIZE);
          const heat = Math.pow(Math.max(0, 1 - p / 0.4), 1.5);
          if (heat > 0.02) {
            this._text(lctx, hot, Math.min(1, heat) * flicker, ch, cx, ly, LOGO_PITCH, LOGO_SIZE);
            if (p < 0.12) {
              lctx.fillStyle = hotFill(0.6 * (1 - p / 0.12) * flicker);
              lctx.fillRect(cx + 2.4 * LOGO_PITCH - 1.5, top, 3, band);
            }
          }
        }

        // DIGITAL SPECTRUM ANALYZER tracks out from tight to wide as it fades in
        const sp = clamp01((t - O.subStart) / (O.subEnd - O.subStart));
        if (sp > 0) {
          const a = 0.62 * flicker * breathe * ease3(sp * 1.4);
          if (sp >= 1) {
            const subW = (LOGO_SUB.length * 6 - 1) * SUB_PITCH + SUB_SIZE;
            this._text(lctx, rgb, a, LOGO_SUB, Math.round((W - subW) / 2), sy, SUB_PITCH, SUB_SIZE);
          } else {
            const n = LOGO_SUB.length;
            const extra = (1 - ease3(sp)) * 9;
            const cw = 6 * SUB_PITCH + extra;
            const x0 = Math.round((W - ((n * 6 - 1) * SUB_PITCH + SUB_SIZE + (n - 1) * extra)) / 2);
            for (let k = 0; k < n; k++) if (LOGO_SUB[k] !== ' ') this._text(lctx, rgb, a, LOGO_SUB[k], Math.round(x0 + k * cw), sy, SUB_PITCH, SUB_SIZE);
          }
        }

        // the glint: a slit that lights the letters it passes at full strength
        if (t >= O.glintStart && t < O.glintEnd + 0.1) {
          const gx = PAD_X + ease3((t - O.glintStart) / (O.glintEnd - O.glintStart)) * (W - PAD_X * 2);
          lctx.save();
          lctx.beginPath();
          lctx.rect(gx - 90, top, 96, band);
          lctx.clip();
          this._text(lctx, hot, Math.min(1, flicker), LOGO_TEXT, lx, ly, LOGO_PITCH, LOGO_SIZE);
          if (sp >= 1) {
            const subW = (LOGO_SUB.length * 6 - 1) * SUB_PITCH + SUB_SIZE;
            this._text(lctx, rgb, 0.85 * flicker, LOGO_SUB, Math.round((W - subW) / 2), sy, SUB_PITCH, SUB_SIZE);
          }
          lctx.restore();
          lctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.9, 0.85 * flicker).toFixed(3) + ')';
          lctx.fillRect(gx, top, 2.4, band);
        }
        lctx.restore();
        lctx.fillStyle = hotFill(0.7 * flicker);
        lctx.fillRect(PAD_X, top - 0.8, W - PAD_X * 2, 1.6);
        lctx.fillRect(PAD_X, top + band - 0.8, W - PAD_X * 2, 1.6);
      }

      // the impact: the whole display flares, a bright streak runs along the centre line, and sparks fly outward
      const fl = openingFlash(t);
      if (fl > 0.01) {
        const age = t - O.flashAt;
        // the flare travels outward from the centre like a shock wave: brightest along the centre line, soft above and
        // below, with a thin bright front at each end
        const reach = fullHalf * ease3(age / 0.26);
        const gr = lctx.createLinearGradient(0, SPEC_TOP - 4, 0, SPEC_TOP + SPEC_H + 4);
        gr.addColorStop(0, hotFill(0));
        gr.addColorStop(0.5, hotFill(0.36 * fl * flicker));
        gr.addColorStop(1, hotFill(0));
        lctx.fillStyle = gr;
        lctx.fillRect(W / 2 - reach, SPEC_TOP - 4, reach * 2, SPEC_H + 8);
        if (age < 0.3) {
          lctx.fillStyle = hotFill(0.8 * (1 - age / 0.3) * flicker);
          lctx.fillRect(W / 2 - reach - 1.5, SPEC_TOP + 20, 3, SPEC_H - 40);
          lctx.fillRect(W / 2 + reach - 1.5, SPEC_TOP + 20, 3, SPEC_H - 40);
        }
        const hh = 3 + 9 * fl;
        lctx.fillStyle = hotFill(1.2 * fl * flicker);
        lctx.fillRect(PAD_X, cy - hh / 2, W - PAD_X * 2, hh);
        if (age >= 0 && age < 0.6) {
          for (let k = 0; k < 30; k++) {
            const x = W / 2 + (k & 1 ? 1 : -1) * (90 + rnd(k, 4) * 640) * ease3(age / 0.6) * (0.35 + 0.65 * rnd(k, 6));
            if (x < PAD_X || x > W - PAD_X) continue;
            const y = cy + (rnd(k, 5) - 0.5) * 90 * Math.sqrt(age);
            lctx.fillStyle = hotFill(Math.pow(1 - age / 0.6, 1.5) * flicker);
            lctx.fillRect(x - 1.3, y - 1.3, 2.6, 2.6);
          }
        }
      }

      // HELLO, typed
      if (t >= O.helloStart) {
        const n = Math.min(5, Math.floor((t - O.helloStart) / 0.09) + 1);
        this._text(lctx, rgb, 0.92 * flicker, 'HELLO'.slice(0, n), PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
        if (n < 5 || Math.floor(t / 0.16) % 2 === 0) {
          lctx.fillStyle = fill(0.9 * flicker);
          lctx.fillRect(PAD_X + n * CHAR_W, STATUS_Y, 4 * DOT_PITCH + DOT_SIZE, 6 * DOT_PITCH + DOT_SIZE);
        }
      }

      // WELCOME, wiped onto the title line by a moving edge
      if (t >= O.titleStart) {
        const p = Math.min(1, (t - O.titleStart) / 0.55);
        const edge = PAD_X + p * (W - PAD_X * 2);
        lctx.save();
        lctx.beginPath();
        lctx.rect(0, 0, edge, H);
        lctx.clip();
        this._drawTitle(lctx, { titleText: 'WELCOME  -  ' + LOGO_TEXT, now: 0, titleStart: 0 }, flicker);
        lctx.restore();
        if (p < 1) {
          lctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.9, 0.8 * flicker).toFixed(3) + ')';
          lctx.fillRect(edge, TITLE_Y - 2, 2.2, (TITLE_ROWS - 1) * TITLE_PITCH + TITLE_SIZE + 4);
        }
      }
    }

    // SCOPE: the waveform as lit segments. The trace is triggered on a rising zero crossing so it holds still, and it is
    // scaled by a slowly following peak so quiet passages still fill the screen. Colours run from cyan at the centre
    // line to amber/red at the edges, like the centre-bar pattern.
    _drawScope(lctx, ui, flicker, rel) {
      const wave = ui.wave;
      const power = ui.power && wave;
      const seg = this.seg;
      const gains = this.segGain;
      let start = 0;
      if (power) {
        for (let i = 1; i < 256; i++) {
          if (wave[i - 1] < 0 && wave[i] >= 0) {
            start = i;
            break;
          }
        }
      }
      let pk = 0.02;
      if (power) for (let i = start; i < start + SC_SPAN; i++) pk = Math.max(pk, Math.abs(wave[i]));
      this.scopePeak = Math.max(pk, this.scopePeak * 0.985);
      const gain = 0.92 / Math.max(this.scopePeak, 0.06);
      const rowOf = (v) => Math.round(((Math.max(-1, Math.min(1, v * gain)) + 1) / 2) * (ROWS - 1));
      let prev = 0;
      for (let c = 0; c < SC_COLS; c++) {
        let lo = ROWS;
        let hi = -1;
        if (power) {
          const i0 = start + Math.floor((c * SC_SPAN) / SC_COLS);
          const i1 = start + Math.floor(((c + 1) * SC_SPAN) / SC_COLS);
          let mn = prev;
          let mx = prev;
          for (let i = i0; i <= i1; i++) {
            if (wave[i] < mn) mn = wave[i];
            if (wave[i] > mx) mx = wave[i];
          }
          prev = wave[i1];
          lo = rowOf(mn);
          hi = rowOf(mx);
        }
        const x = PAD_X + c * SC_PITCH + (SC_PITCH - SC_W) / 2;
        const base = c * ROWS;
        for (let r = 0; r < ROWS; r++) {
          const b = (seg[base + r] = follow(seg[base + r], r >= lo && r <= hi ? 1 : 0, rel));
          if (b === 0) continue;
          const d = Math.abs(r - (ROWS - 1) / 2);
          this._segment(lctx, x, ROW_Y[r], SC_W, SEG_H, this.rowPrefix[Math.min(ROWS - 1, Math.floor(d * 2))], b * flicker * gains[base + r]);
        }
      }
    }

    // Graphic-EQ editor: bars grow up from the centre line for boost and down for cut.
    _drawEq(lctx, ui, flicker, rel) {
      const cols = this.cols;
      const seg = this.seg;
      const gains = ui.eq;
      const rowPrefix = this.rowPrefix;
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const g = gains ? gains[col.band] : 0;
        const n = Math.round((Math.abs(g) / 12) * (ROWS / 2));
        const base = c * ROWS;
        for (let r = 0; r < ROWS; r++) {
          let target = r === ROWS / 2 - 1 || r === ROWS / 2 ? 0.42 : 0; // 0 dB reference
          if (g > 0 && r >= ROWS / 2 && r < ROWS / 2 + n) target = 1;
          if (g < 0 && r <= ROWS / 2 - 1 && r > ROWS / 2 - 1 - n) target = 1;
          const b = (seg[base + r] = follow(seg[base + r], target, rel));
          if (b === 0) continue;
          this._segment(lctx, col.x, ROW_Y[r], col.w, SEG_H, rowPrefix[r], b * flicker * this.segGain[base + r]);
        }
      }
    }

    _drawLevel(lctx, ui, flicker, rel) {
      const m = ui.meter;
      const prefix = this.lvPrefix;
      const rgb = this.theme.text.join(',');
      for (let ch = 0; ch < 2; ch++) {
        const bar = m ? Math.round(m.bars[ch] * LV_SEGS) : 0;
        const pk = m ? m.peaks[ch] : 0;
        const peakSeg = pk > 0.5 / LV_SEGS ? Math.min(LV_SEGS - 1, Math.ceil(pk * LV_SEGS - 1e-6) - 1) : -1;
        const base = ch * LV_SEGS;
        for (let i = 0; i < LV_SEGS; i++) {
          const b = (this.levelSeg[base + i] = follow(this.levelSeg[base + i], i < bar || i === peakSeg ? 1 : 0, rel));
          if (b === 0) continue;
          this._segment(lctx, LV_X0 + i * LV_PITCH, LV_Y[ch], LV_SEGW, LV_H, prefix[i], b * flicker * this.lvGain[base + i]);
        }
      }
      this._text(lctx, rgb, 0.92 * flicker, 'L', 44, LV_Y[0] + (LV_H - 42) / 2, LV_CH_PITCH, LV_CH_SIZE);
      this._text(lctx, rgb, 0.92 * flicker, 'R', 44, LV_Y[1] + (LV_H - 42) / 2, LV_CH_PITCH, LV_CH_SIZE);

      // dB scale under the meters
      lctx.fillStyle = 'rgba(' + rgb + ',' + 0.55 * flicker + ')';
      for (const db of LV_TICKS) {
        const x = LV_X0 + ((db + 60) / 60) * LV_SEGS * LV_PITCH - LV_GAP / 2;
        lctx.fillRect(x - 0.8, LV_TICK_Y, 1.6, 7);
        const text = String(db);
        const tw = text.length * 6 * LABEL_PITCH - LABEL_PITCH;
        const tx = Math.min(LV_X1 - tw + 2, Math.max(LV_X0 - 8, x - tw / 2));
        this._text(lctx, rgb, 0.55 * flicker, text, Math.round(tx), LV_LABEL_Y, LABEL_PITCH, LABEL_SIZE);
      }

      // peak read-out
      const pl = m ? m.peaks[0] : 0;
      const pr = m ? m.peaks[1] : 0;
      const text = ('PEAK L ' + fmtDb(pl) + '  R ' + fmtDb(pr) + ' DB').slice(0, LV_READ_CELLS);
      const x = (W - (LV_READ_CELLS * 6 * LV_READ_PITCH - LV_READ_PITCH)) / 2;
      glowText(lctx, rgb, 0.85 * flicker, text, x, LV_READ_Y, LV_READ_PITCH, LV_READ_SIZE);
    }

    _drawClock(lctx, ui, flicker, rel) {
      const c = ui.clock || { text: '00:00', date: '', sec: 0 };
      const rgb = this.theme.text.join(',');
      const text = ui.allOn ? '88:88' : c.text;
      lctx.fillStyle = 'rgba(' + rgb + ',' + 0.95 * flicker + ')';
      lctx.beginPath();
      const digits = [text[0], text[1], text[3], text[4]];
      for (let i = 0; i < 4; i++) digitPath(lctx, D7_XS[i], D7_Y, SEG7_MAP[digits[i]] || 0);
      if (text[2] === ':') colonRects(lctx, D7_Y);
      lctx.fill();
      const date = (c.date || '').toUpperCase().slice(0, DATE_CELLS);
      this._text(lctx, rgb, 0.8 * flicker, date, DATE_X + Math.floor((DATE_CELLS - date.length) / 2) * 6 * DATE_PITCH, DATE_Y, DATE_PITCH, DATE_SIZE);
      const sec = ui.allOn ? SEC_SEGS : c.sec;
      for (let i = 0; i < SEC_SEGS; i++) {
        const target = i === sec ? 1 : i < sec ? 0.5 : 0;
        const b = (this.secSeg[i] = follow(this.secSeg[i], target, rel));
        if (b === 0) continue;
        lctx.fillStyle = 'rgba(' + rgb + ',' + (b * flicker).toFixed(3) + ')';
        lctx.fillRect(SEC_X + i * SEC_PITCH, SEC_Y, 10, 10);
      }
    }

    _drawOsd(lctx, ui, flicker, rel) {
      const o = ui.osd || { label: 'VOL', value: 0, max: OSD_SEGS };
      const rgb = this.theme.text.join(',');
      this._text(lctx, rgb, 0.95 * flicker, (o.label || '').toUpperCase().slice(0, 4), OSD_LABEL_X, OSD_LABEL_Y, OSD_LABEL_PITCH, OSD_LABEL_SIZE);
      lctx.fillStyle = 'rgba(' + rgb + ',' + 0.95 * flicker + ')';
      const v = Math.max(0, Math.min(99, Math.round(o.value)));
      const digits = [String(Math.floor(v / 10)), String(v % 10)];
      lctx.beginPath();
      for (let i = 0; i < 2; i++) digitPath(lctx, OSD_DIGIT_X[i], D7_Y, i === 0 && v < 10 ? 0 : SEG7_MAP[digits[i]]);
      lctx.fill();
      const n = Math.round((v / (o.max || OSD_SEGS)) * OSD_SEGS);
      for (let i = 0; i < OSD_SEGS; i++) {
        const b = (this.osdSeg[i] = follow(this.osdSeg[i], i < n ? 1 : 0, rel));
        if (b === 0) continue;
        this._segment(lctx, OSD_BAR_X + i * OSD_BAR_PITCH, OSD_BAR_Y, 18, 30, this.osdPrefix[i], b * flicker * phosphorGain(OSD_BAR_X + i * OSD_BAR_PITCH, OSD_BAR_Y));
      }
    }

    // Annunciators: each fades through the phosphor afterglow like any other segment.
    _drawAnn(lctx, ui, flicker, rel) {
      const rgb = this.theme.text.join(',');
      for (let i = 0; i < ANN_ITEMS.length; i++) {
        const it = ANN_ITEMS[i];
        const on = ui.allOn || (ui.ann && ui.ann[it.id]);
        const b = (this.annSeg[i] = follow(this.annSeg[i], on ? 1 : 0, rel));
        if (b === 0) continue;
        lctx.fillStyle = 'rgba(' + rgb + ',' + (b * flicker * 0.92).toFixed(3) + ')';
        annShape(lctx, it, rgb, b * flicker * 0.92, this);
      }
    }

    // One lit phosphor segment, drawn from a pre-rendered sprite: rounded corners, a soft skirt (the coating does
    // not end at a razor edge), a paler hot core, and slightly deeper colour where the coating thins at the rim.
    _segSprite(prefix, w, h) {
      const key = prefix + w.toFixed(1) + 'x' + h.toFixed(1);
      let sp = this.sprites.get(key);
      if (sp) return sp;
      const S = this.scale;
      const pad = SEG_PAD;
      const cw = Math.ceil((w + 2 * pad) * S);
      const ch = Math.ceil((h + 2 * pad) * S);
      const c = makeCanvas(cw, ch);
      const g = c.getContext('2d');
      g.setTransform(S, 0, 0, S, 0, 0);
      const r = Math.min(1.6, h * 0.16);

      g.beginPath();
      addRoundRect(g, pad - 0.9, pad - 0.9, w + 1.8, h + 1.8, r + 0.9);
      g.fillStyle = prefix + '0.2)';
      g.fill();

      g.beginPath();
      addRoundRect(g, pad, pad, w, h, r);
      g.fillStyle = prefix + '1)';
      g.fill();

      g.save();
      g.beginPath();
      addRoundRect(g, pad, pad, w, h, r);
      g.clip();
      g.translate(pad + w / 2, pad + h / 2);
      g.scale(1, h / w); // stretch the circular falloff to the segment's aspect
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, w / 2);
      grad.addColorStop(0, 'rgba(255,255,255,0.38)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.14)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(-w / 2, -w / 2, w, w);
      g.restore();

      g.beginPath();
      addRoundRect(g, pad + 0.4, pad + 0.4, w - 0.8, h - 0.8, r);
      g.strokeStyle = 'rgba(0,0,0,0.14)';
      g.lineWidth = 0.8;
      g.stroke();

      sp = { c, lw: cw / S, lh: ch / S };
      this.sprites.set(key, sp);
      return sp;
    }

    _segment(lctx, x, y, w, h, prefix, a) {
      const sp = this._segSprite(prefix, w, h);
      const S = this.scale;
      lctx.globalAlpha = a > 1 ? 1 : a;
      lctx.drawImage(sp.c, Math.round((x - SEG_PAD) * S) / S, Math.round((y - SEG_PAD) * S) / S, sp.lw, sp.lh);
      lctx.globalAlpha = 1;
    }

    // A segment leaning by `k` (dx per dy) about its own centre: the columns of the PERSPECTIVE pattern.
    _segmentSheared(lctx, cx, y, w, h, k, prefix, a) {
      const sp = this._segSprite(prefix, w, h);
      const S = this.scale;
      lctx.globalAlpha = a > 1 ? 1 : a;
      lctx.setTransform(S, 0, S * k, S, S * cx, S * (y + h / 2));
      lctx.drawImage(sp.c, -w / 2 - SEG_PAD, -h / 2 - SEG_PAD, sp.lw, sp.lh);
      lctx.setTransform(S, 0, 0, S, 0, 0);
      lctx.globalAlpha = 1;
    }

    _titleSprite(text, rgb) {
      return this._dotSprite(text, rgb, TITLE_PITCH, TITLE_SIZE);
    }

    // A line of OS-font dot-matrix text (16 rows) as a cached sprite at the given dot pitch and size.
    _dotSprite(text, rgb, pitch, size) {
      const key = text + '|' + rgb + '|' + pitch + '|' + size;
      let sp = this.titleCache.get(key);
      if (sp) return sp;
      const chars = Array.from(text).slice(0, 100);
      const glyphs = chars.map(glyphBitmap);
      const cols = glyphs.reduce((a, gl) => a + gl.w + 1, 0);
      const S = this.scale;
      const pad = TEXT_PAD;
      const cw = Math.ceil(((cols - 1) * pitch + size + 2 * pad) * S);
      const ch = Math.ceil(((TITLE_ROWS - 1) * pitch + size + 2 * pad) * S);
      const c = makeCanvas(cw, ch);
      const g = c.getContext('2d');
      g.setTransform(S, 0, 0, S, 0, 0);
      const pass = (grow, alpha) => {
        g.beginPath();
        let col = 0;
        for (const gl of glyphs) {
          for (let y = 0; y < TITLE_ROWS; y++) {
            const bits = gl.rows[y];
            if (!bits) continue;
            for (let x = 0; x < gl.w; x++) {
              if (bits & (1 << x)) {
                addRoundRect(g, pad + (col + x) * pitch - grow, pad + y * pitch - grow, size + 2 * grow, size + 2 * grow, size * 0.3 + grow * 0.5);
              }
            }
          }
          col += gl.w + 1;
        }
        g.fillStyle = 'rgba(' + rgb + ',' + alpha + ')';
        g.fill();
      };
      pass(2.4, 0.07);
      pass(1.1, 0.17);
      pass(0, 1);
      sp = { c, lw: cw / S, lh: ch / S, cols };
      if (this.titleCache.size > 30) this.titleCache.clear();
      this.titleCache.set(key, sp);
      return sp;
    }

    _drawTitle(lctx, ui, flicker) {
      const text = ui.titleText;
      if (!text) return;
      const sp = this._titleSprite(text, this.theme.text.join(','));
      const S = this.scale;
      const x0 = PAD_X - TEXT_PAD;
      const y0 = Math.round((TITLE_Y - TEXT_PAD) * S) / S;
      lctx.save();
      lctx.beginPath();
      lctx.rect(PAD_X - 3, TITLE_Y - 4, W - PAD_X * 2 + 6, (TITLE_ROWS - 1) * TITLE_PITCH + TITLE_SIZE + 8);
      lctx.clip();
      lctx.globalAlpha = Math.min(1, 0.95 * flicker);
      if (sp.cols <= TITLE_COLS) {
        lctx.drawImage(sp.c, Math.round(x0 * S) / S, y0, sp.lw, sp.lh);
      } else {
        // longer than the field: scroll one dot column at a time, looping with a gap
        const period = sp.cols + TITLE_GAP_COLS;
        const elapsed = Math.max(0, (ui.now || 0) - (ui.titleStart || 0) - TITLE_HOLD_MS);
        const off = Math.floor(elapsed * TITLE_COLS_PER_MS) % period;
        lctx.drawImage(sp.c, Math.round((x0 - off * TITLE_PITCH) * S) / S, y0, sp.lw, sp.lh);
        lctx.drawImage(sp.c, Math.round((x0 + (period - off) * TITLE_PITCH) * S) / S, y0, sp.lw, sp.lh);
      }
      lctx.restore();
    }

    // Dot-matrix text as a cached sprite: round dots with a hot centre and two soft glow passes baked in.
    // `solid` (dot size == pitch) gives the bold fixed-shape look of annunciators, so no rounding there.
    _text(lctx, rgb, a, text, x, y, pitch, size, solid) {
      if (!text) return;
      const key = text + '|' + pitch + '|' + size + '|' + rgb + (solid ? 's' : '');
      let sp = this.textCache.get(key);
      if (!sp) {
        const S = this.scale;
        const pad = TEXT_PAD;
        const n = text.length;
        const cw = Math.ceil(((n * 6 - 1) * pitch + size + 2 * pad) * S);
        const ch = Math.ceil((6 * pitch + size + 2 * pad) * S);
        const c = makeCanvas(cw, ch);
        const g = c.getContext('2d');
        g.setTransform(S, 0, 0, S, 0, 0);
        const dots = (grow, radius) => {
          g.beginPath();
          for (let i = 0; i < n; i++) {
            const glyph = FONT[text[i]] || FONT['?'];
            const gx = pad + i * 6 * pitch;
            for (let col = 0; col < 5; col++) {
              const bits = glyph[col];
              if (!bits) continue;
              for (let row = 0; row < 7; row++) {
                if (bits & (1 << row)) addRoundRect(g, gx + col * pitch - grow, pad + row * pitch - grow, size + 2 * grow, size + 2 * grow, radius + grow * 0.5);
              }
            }
          }
        };
        const r = solid ? 0 : size * 0.3;
        dots(2.6, r);
        g.fillStyle = 'rgba(' + rgb + ',0.07)';
        g.fill();
        dots(1.2, r);
        g.fillStyle = 'rgba(' + rgb + ',0.17)';
        g.fill();
        dots(0, r);
        g.fillStyle = 'rgba(' + rgb + ',1)';
        g.fill();
        if (!solid) {
          // hot centre of each dot
          g.beginPath();
          const q = size * 0.28;
          for (let i = 0; i < n; i++) {
            const glyph = FONT[text[i]] || FONT['?'];
            const gx = pad + i * 6 * pitch;
            for (let col = 0; col < 5; col++) {
              const bits = glyph[col];
              if (!bits) continue;
              for (let row = 0; row < 7; row++) {
                if (bits & (1 << row)) g.rect(gx + col * pitch + q, pad + row * pitch + q, size - 2 * q, size - 2 * q);
              }
            }
          }
          g.fillStyle = 'rgba(255,255,255,0.22)';
          g.fill();
        }
        sp = { c, lw: cw / S, lh: ch / S };
        if (this.textCache.size > 200) this.textCache.clear();
        this.textCache.set(key, sp);
      }
      const S = this.scale;
      lctx.globalAlpha = a > 1 ? 1 : a;
      lctx.drawImage(sp.c, Math.round((x - TEXT_PAD) * S) / S, Math.round((y - TEXT_PAD) * S) / S, sp.lw, sp.lh);
      lctx.globalAlpha = 1;
    }

    // ui: { power, standby, warm, brightness, mode: 'bar'|'peak'|'mirror', dt, leftText, amber, rightText,
    //       eq: Float32Array(15), meter: SpectrumModel(2), clock: { text, date, sec } }
    render(model, ui) {
      const S = this.scale;
      const lctx = this.litCtx;
      const rel = Math.exp(-(ui.dt || 0.033) / SEG_RELEASE_TAU);
      // overall drive: warm-up / fade-out ramp (or the dim standby level) x DIM setting; the per-frame random
      // term is the faint brightness shimmer of a multiplexed VFD
      const drive = ui.standby ? STANDBY_GAIN : ui.warm === undefined ? 1 : ui.warm;
      const gain = drive * (ui.brightness === undefined ? 1 : ui.brightness);
      // heater-filament beat (a slow ~1.3 Hz shimmer from aliasing the AC drive) plus a little noise
      const beat = 0.5 + 0.5 * Math.sin((performance.now() / 1000) * 8.2);
      const flicker = (1 - 0.022 * beat - 0.018 * Math.random()) * gain;
      this.parX = (ui.parX || 0) * 2.6 * S;
      this.parY = (ui.parY || 0) * 1.8 * S;
      this.haloBoost = 1 + 0.55 * Math.min(1, (ui.activity || 0) * drive);
      if (ui.opening) {
        // the glow blooms wider at the impact and while the slit sweeps the logo
        const ot = ui.openT || 0;
        this.haloBoost += 1.5 * openingFlash(ot) + 0.45 * hump(ot - OPENING.glintStart, 0.3, 0.5);
      }
      this.heat = ui.heat === undefined ? 0 : ui.heat;

      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, this.pxW, this.pxH);
      lctx.setTransform(S, 0, 0, S, 0, 0);

      const lit = ui.power || ui.standby;
      if (lit && ui.opening && this.kind === 'bars') {
        this._drawOpening(lctx, model, ui, flicker, rel);
      } else if (lit) {
        if (this.kind === 'bars') (this.fan ? this._drawFan : this._drawBars).call(this, lctx, model, ui, flicker, rel);
        else if (this.kind === 'eq') this._drawEq(lctx, ui, flicker, rel);
        else if (this.kind === 'scope') this._drawScope(lctx, ui, flicker, rel);

        if (this.kind === 'bars' || this.kind === 'eq') this._drawLabels(lctx, flicker);
        else if (this.kind === 'level') this._drawLevel(lctx, ui, flicker, rel);
        else if (this.kind === 'osd') this._drawOsd(lctx, ui, flicker, rel);
        else if (this.kind !== 'scope') this._drawClock(lctx, ui, flicker, rel);
        if (ui.power) {
          if (ui.allOn) {
            lctx.fillStyle = 'rgba(' + this.theme.text.join(',') + ',' + 0.9 * flicker + ')';
            gridPath(lctx, LEFT_CELLS, PAD_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
            gridPath(lctx, RIGHT_CELLS, RIGHT_X, STATUS_Y, DOT_PITCH, DOT_SIZE);
          } else {
            this._drawStatus(lctx, ui, flicker);
          }
          this._drawAnn(lctx, ui, flicker, rel);
          if (this.kind === 'bars' || this.kind === 'eq' || this.kind === 'level' || this.kind === 'scope') this._drawTitle(lctx, ui, flicker);
        }
      }

      this._composite();
    }

    _composite() {
      const ctx = this.ctx;
      const { pxW, pxH, mips } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(this.unlit, 0, 0);

      // blur pyramid
      let src = this.lit;
      for (const m of mips) {
        m.ctx.clearRect(0, 0, m.w, m.h);
        m.ctx.drawImage(src, 0, 0, m.w, m.h);
        for (let s = 0; s < m.smears; s++) smear(m);
        src = m.c;
      }

      // weighted sum, smallest level first: acc[k] = w[k] * level[k] + up(acc[k+1]). The values stay well below
      // 1.0, so the 8-bit canvases never clamp; only the final level is drawn at full size.
      for (let k = mips.length - 1; k >= 0; k--) {
        const m = mips[k];
        m.actx.globalCompositeOperation = 'source-over';
        m.actx.globalAlpha = 1;
        m.actx.clearRect(0, 0, m.w, m.h);
        m.actx.globalAlpha = Math.min(1, HALO_WEIGHTS[k] * this.haloBoost); // a brighter display blooms wider
        m.actx.drawImage(m.c, 0, 0);
        if (k < mips.length - 1) {
          m.actx.globalCompositeOperation = 'lighter';
          m.actx.globalAlpha = 1;
          m.actx.drawImage(mips[k + 1].acc, 0, 0, m.w, m.h);
        }
      }

      // the glow goes down first and the segments are drawn over it, so a segment's own colour is never
      // washed out; the glow shows in the gaps between segments and around them
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(mips[0].acc, 0, 0, pxW, pxH);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.lit, 0, 0);
      ctx.drawImage(this.overlay, -this.overlayM + this.parX, -this.overlayM + this.parY);
      if (this.heat > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.6 * this.heat;
        for (const b of this.filamentBands) {
          ctx.drawImage(this.filamentGlow, 0, b.y, this.filamentGlow.width, b.h, -this.overlayM + this.parX, -this.overlayM + this.parY + b.y, this.filamentGlow.width, b.h);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  VFD.VfdRenderer = VfdRenderer;
  VFD.OPENING = OPENING;
  VFD.openingLevels = openingLevels;
  VFD.openingGlow = openingGlow;
  VFD.THEMES = THEMES;
  VFD.hueTheme = hueTheme;
  VFD.hslRgb = hslRgb;
})(window);
