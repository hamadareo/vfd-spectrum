(function () {
  'use strict';
  const { AudioEngine, SpectrumModel, VfdRenderer, THEMES, readTags, OPENING, openingLevels, openingGlow, hueTheme, hslRgb, createSettings } = window.VFD;

  const MODES = [
    { id: 'bar', kind: 'bars', label: 'NORMAL BAR' },
    { id: 'peak', kind: 'bars', label: 'PEAK ONLY' },
    { id: 'mirror', kind: 'bars', label: 'MIRROR' },
    { id: 'center', kind: 'bars', label: 'CENTER BAR' },
    { id: 'level', kind: 'level', label: 'LEVEL METER' },
    { id: 'fan', kind: 'bars', label: 'PERSPECTIVE' },
    { id: 'scope', kind: 'scope', label: 'SCOPE' },
    { id: 'clock', kind: 'clock', label: 'CLOCK' },
  ];
  const EQ_MODE = { id: 'eq', kind: 'eq', label: 'EQ EDIT' };
  const STANDBY_MODE = { id: 'standby', kind: 'clock', label: 'STANDBY' };
  const OSD_MODE = { id: 'osd', kind: 'osd', label: 'VOLUME' };
  const OSD_MS = 1700; // how long the volume screen stays up after the knob stops
  const BAND_CYCLE = { 15: 13, 13: 9, 9: 15 };
  const OPEN_MS = OPENING.total * 1000; // the power-on opening (display, lighting and sound share one timeline)
  const EQ_SHOW_MS = 3000; // how long a preset change shows the EQ screen
  const HOLD_MS = 420;
  const HOLD_REPEAT_MS = 140;
  const HOLD_SEEK_SEC = 1.5; // per repeat; grows the longer the key is held
  const STANDBY_DRIVE = 0.45;
  const PREFS_KEY = 'vfd-spectrum:v3';
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // analyzer dynamics: bar fall time constant, peak-hold time and peak fall gravity
  const SPEEDS = [
    { name: 'NORMAL', decayTau: 0.22, peakHold: 0.8, peakGravity: 1.5 },
    { name: 'FAST', decayTau: 0.11, peakHold: 0.5, peakGravity: 2.6 },
    { name: 'SLOW', decayTau: 0.42, peakHold: 1.4, peakGravity: 0.9 },
  ];

  const EQ_PRESETS = [
    { name: 'FLAT', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'ROCK', gains: [5, 4, 3, 1, -1, -2, -1, 1, 3, 4, 5, 5, 4, 3, 2] },
    { name: 'POP', gains: [-1, 0, 2, 3, 3, 2, 0, -1, -1, 0, 1, 2, 2, 1, 0] },
    { name: 'JAZZ', gains: [3, 3, 2, 1, 0, 1, 2, 2, 1, 0, 1, 2, 2, 3, 3] },
    { name: 'BASS', gains: [8, 7, 6, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: 'VOCAL', gains: [-3, -2, -1, 0, 2, 3, 4, 4, 3, 2, 1, 0, -1, -2, -3] },
    { name: 'USER', gains: null },
  ];
  const USER_PRESET = EQ_PRESETS.length - 1;
  const DSP_NAMES = AudioEngine.DSP_NAMES;
  // key illumination colour, separate from the display colour (AUTO follows the display theme)
  const ILLUMS = [
    { name: 'AUTO', rgb: null },
    { name: 'AMBER', rgb: [255, 168, 60] },
    { name: 'WHITE', rgb: [236, 242, 255] },
    { name: 'BLUE', rgb: [96, 150, 255] },
    { name: 'GREEN', rgb: [90, 255, 140] },
    { name: 'RED', rgb: [255, 84, 72] },
    { name: 'PURPLE', rgb: [184, 112, 255] },
    { name: 'PINK', rgb: [255, 112, 190] },
    { name: 'ORANGE', rgb: [255, 120, 40] },
    { name: 'YELLOW', rgb: [255, 225, 80] },
    { name: 'LIME', rgb: [170, 255, 80] },
    { name: 'MINT', rgb: [90, 255, 210] },
    { name: 'CYAN', rgb: [70, 235, 255] },
    { name: 'SKY', rgb: [100, 190, 255] },
    { name: 'INDIGO', rgb: [130, 110, 255] },
    { name: 'MAGENTA', rgb: [235, 90, 235] },
    { name: 'CUSTOM', rgb: null, custom: true }, // hue from the slider
  ];
  const CUSTOM_ILLUM = ILLUMS.length - 1;
  const CUSTOM_THEME = THEMES.length - 1; // the last theme slot is rebuilt from the sliders
  const MOTIONS = AudioEngine.MOTIONS;

  const NATIVE = !!window.VFD_NATIVE; // running inside the Mac app (WKWebView host)
  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#vfd');
  const glass = $('#glass');
  const faceplate = $('#faceplate');
  const fileInput = $('#file-input');
  const pad2 = (n) => String(n).padStart(2, '0');

  const engine = new AudioEngine();
  const model = new SpectrumModel(engine.bandCount);
  const meter = new SpectrumModel(2, { decayTau: 0.35, peakHold: 1.2, peakGravity: 0.5 });
  const renderer = new VfdRenderer(canvas);

  const state = {
    power: false,
    modeIdx: 0,
    eqEdit: false,
    fps: 30,
    source: null,
    tracks: [],
    trackIdx: 0,
    fileName: '',
    trackTitle: '',
    np: null,
    npAt: 0,
    volTouchedAt: -1e9, // never touched: performance.now() starts near 0 at page load
    titleKey: '',
    titleStart: 0,
    flashText: '',
    flashUntil: 0,
    tempEqUntil: 0,
    osdUntil: 0,
    osd: { label: 'VOL', value: 0, max: 40 },
    bootStart: 0,
    openHold: -1, // developer aid: freeze the opening at this many seconds (vfdApp.holdOpening)
    byeUntil: 0,
    themeIdx: 0,
    speedIdx: 0,
    dim: false,
    dimLevel: 7,
    silentSince: 0,
    theater: false,
    illumIdx: 0,
    opening: true, // play the power-on opening
    autoStart: true, // Mac app: power on by itself at launch
    autoPattern: 0, // seconds between automatic pattern changes (0 = off)
    autoNextAt: 0,
    sleepAt: 0, // when the sleep timer switches the unit off (0 = no timer; never saved)
    sleepMin: 0,
    sleepWarned: false,
    keepOnTop: !!(window.VFD_NATIVE && window.VFD_NATIVE.keepOnTop),
    keepAwake: true, // web build: keep the screen on while the unit is powered on (Screen Wake Lock)
    lastSource: '', // last live input ('mic' or 'tab'), restored at the next start of the Mac app
    problem: '', // what the settings screen should explain: '', 'mic', 'sys-denied', 'sys-error', 'sys-old', 'tab', 'music'
    customHue: 200,
    customSat: 100,
    illumHue: 30,
    sync: false,
    warm: 0,
    heat: 0,
    glow: 0,
    pulse: 0,
    eqPreset: 0,
    eqGains: new Float32Array(15),
    eqUser: new Float32Array(15),
  };

  // ---- persistence: the unit remembers its settings, like a real head unit -------------------
  function loadPrefs() {
    // In the Mac app the settings live in a file of the app's own, handed over as window.VFD_PREFS; the browser copy
    // (localStorage) is the fallback for the browser build and for the first run after an update.
    if (window.VFD_PREFS && typeof window.VFD_PREFS === 'object') return window.VFD_PREFS;
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  let saveTimer = null;
  function prefsObject() {
    return {
      power: state.power,
      modeIdx: MODES[state.modeIdx].kind === 'clock' ? 0 : state.modeIdx, // never boot into the clock
      bandCount: engine.bandCount,
      themeIdx: state.themeIdx,
      speedIdx: state.speedIdx,
      tiltIdx: panel.tiltIdx,
      panelAngle: panel.rest,
      dim: state.dim,
      dimLevel: state.dimLevel,
      sync: state.sync,
      agc: engine.agc,
      sound: engine.uiSound,
      dsp: engine.dsp,
      motion: engine.motionIdx,
      theater: state.theater,
      illum: state.illumIdx,
      opening: state.opening,
      autoStart: state.autoStart,
      autoPattern: state.autoPattern,
      keepAwake: state.keepAwake,
      customHue: state.customHue,
      customSat: state.customSat,
      illumHue: state.illumHue,
      fps: state.fps,
      volume: knobs.vol.value,
      sens: knobs.sens.value,
      eqPreset: state.eqPreset,
      eqUser: Array.from(state.eqUser),
      source: state.lastSource, // the last live input, picked up again at the next start of the Mac app
    };
  }
  // Writes the settings now: the browser copy, and (Mac app) the app's own file through the bridge.
  function savePrefsNow() {
    clearTimeout(saveTimer);
    let json;
    try { json = JSON.stringify(prefsObject()); } catch (e) { return; }
    try { localStorage.setItem(PREFS_KEY, json); } catch (e) { /* storage blocked: settings just won't persist there */ }
    if (NATIVE) {
      try { window.webkit.messageHandlers.vfd.postMessage({ cmd: 'savePrefs', json }); } catch (e) { /* no bridge */ }
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePrefsNow, 400);
  }
  // a change made just before the window is hidden or closed must not wait for the timer
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePrefsNow(); });
  window.addEventListener('pagehide', savePrefsNow);

  // Web build (iPad on the dashboard, for instance): keep the screen from dimming while the unit is on. The lock is
  // released by the browser whenever the page is hidden, so it is asked for again when the page comes back.
  const WAKE_LOCK = 'wakeLock' in navigator && !NATIVE;
  let wakeLock = null;
  let wakeBusy = false;
  async function updateWakeLock() {
    if (!WAKE_LOCK || wakeBusy) return;
    const want = state.keepAwake && state.power && document.visibilityState === 'visible';
    if (want === !!wakeLock) return;
    wakeBusy = true;
    try {
      if (want) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {
      wakeLock = null; // refused (low battery, no gesture yet ...): tried again at the next change or touch
    }
    wakeBusy = false;
  }
  document.addEventListener('visibilitychange', updateWakeLock);
  document.addEventListener('pointerdown', updateWakeLock, { passive: true });

  try { localStorage.removeItem('vfd-spectrum:lyrics:v1'); } catch (e) { /* storage blocked */ } // lyrics kept by an earlier build
  const prefs = loadPrefs();
  if (Number.isInteger(prefs.modeIdx) && MODES[prefs.modeIdx]) state.modeIdx = prefs.modeIdx;
  if (BAND_CYCLE[prefs.bandCount]) {
    engine.setBandCount(prefs.bandCount);
    model.resize(prefs.bandCount);
  }
  if (Number.isInteger(prefs.themeIdx) && THEMES[prefs.themeIdx]) state.themeIdx = prefs.themeIdx;
  if (Number.isInteger(prefs.speedIdx) && SPEEDS[prefs.speedIdx]) state.speedIdx = prefs.speedIdx;
  const savedTilt = Number.isInteger(prefs.tiltIdx) && prefs.tiltIdx >= 0 && prefs.tiltIdx < 3 ? prefs.tiltIdx : 0;
  state.dim = !!prefs.dim;
  if (Number.isInteger(prefs.dimLevel) && prefs.dimLevel >= 1 && prefs.dimLevel <= 13) state.dimLevel = prefs.dimLevel;
  state.sync = !!prefs.sync;
  if (typeof prefs.agc === 'boolean') engine.agc = prefs.agc;
  if (typeof prefs.sound === 'boolean') engine.uiSound = prefs.sound;
  if (prefs.fps === 60) state.fps = 60;
  if (Number.isInteger(prefs.dsp) && prefs.dsp > 0 && prefs.dsp < DSP_NAMES.length) engine.dsp = prefs.dsp;
  if (Number.isInteger(prefs.motion) && MOTIONS[prefs.motion]) engine.motionIdx = prefs.motion;
  state.theater = prefs.theater === true;
  if (Number.isInteger(prefs.illum) && ILLUMS[prefs.illum]) state.illumIdx = prefs.illum;
  state.opening = prefs.opening !== false;
  // (older versions remembered the last power state instead of having this setting)
  state.autoStart = typeof prefs.autoStart === 'boolean' ? prefs.autoStart : prefs.power !== false;
  if ([15, 30, 60].includes(prefs.autoPattern)) state.autoPattern = prefs.autoPattern;
  if (typeof prefs.keepAwake === 'boolean') state.keepAwake = prefs.keepAwake;
  if (prefs.source === 'mic' || prefs.source === 'tab') state.lastSource = prefs.source;
  if (Number.isFinite(prefs.customHue)) state.customHue = ((Math.round(prefs.customHue) % 360) + 360) % 360;
  if (Number.isFinite(prefs.customSat)) state.customSat = Math.max(15, Math.min(100, Math.round(prefs.customSat)));
  if (Number.isFinite(prefs.illumHue)) state.illumHue = ((Math.round(prefs.illumHue) % 360) + 360) % 360;
  THEMES[CUSTOM_THEME] = hueTheme('CUSTOM', state.customHue, state.customSat / 100);
  if (Array.isArray(prefs.eqUser) && prefs.eqUser.length === 15) state.eqUser.set(prefs.eqUser.map((v) => Math.max(-12, Math.min(12, Number(v) || 0))));
  if (Number.isInteger(prefs.eqPreset) && EQ_PRESETS[prefs.eqPreset]) state.eqPreset = prefs.eqPreset;

  // ---- helpers -------------------------------------------------------------
  function flash(text, ms = 1600) {
    state.flashText = text;
    state.flashUntil = performance.now() + ms;
  }

  // Seconds into the opening, or -1 when the unit is not opening.
  function openingTime(now) {
    if (!state.power || !state.opening || reduceMotion) return -1; // flashing scenes are skipped for "reduce motion"
    const t = state.openHold >= 0 ? state.openHold : (now - state.bootStart) / 1000;
    return t < OPENING.total ? t : -1;
  }

  function effectiveMode(now) {
    if (!state.power && state.warm <= 0.01) return STANDBY_MODE;
    if (openingTime(now) >= 0) return MODES[0]; // the opening is drawn on the normal bar layout
    if (state.power && now < state.osdUntil) return OSD_MODE;
    if (state.eqEdit || now < state.tempEqUntil) return EQ_MODE;
    return MODES[state.modeIdx];
  }

  let layoutKey = '';
  function refreshLayout(mode) {
    const bandCount = mode.kind === 'eq' ? 15 : engine.bandCount;
    const key = mode.id + '|' + bandCount;
    if (key === layoutKey) return;
    layoutKey = key;
    renderer.setLayout({
      kind: mode.kind,
      bandCount,
      mirror: mode.id === 'mirror',
      fan: mode.id === 'fan',
      labels: mode.kind === 'eq' ? engine.eqLabels : engine.bands.map((b) => b.label),
    });
  }

  const tallyEls = Array.from(document.querySelectorAll('.tally i'));
  let settingsUI = null; // the settings screen (set up further down)
  let settingsEl = null;
  function syncUI() {
    faceplate.classList.toggle('off', !state.power);
    faceplate.classList.toggle('disc', state.source === 'file');
    faceplate.dataset.dim = state.dim ? '1' : '0';
    faceplate.dataset.sync = state.sync ? '1' : '0';
    const on = (action, v) => {
      const el = document.querySelector('[data-action="' + action + '"]');
      if (el) el.classList.toggle('on', !!v && state.power);
    };
    on('src-demo', state.source === 'demo');
    on('src-mic', state.source === 'mic');
    on('src-tab', state.source === 'tab');
    on('src-file', state.source === 'file');
    on('play', isPlaying());
    on('mode', state.modeIdx !== 0);
    on('band', engine.bandCount !== 15);
    on('speed', state.speedIdx !== 0);
    on('agc', engine.agc);
    on('fps', state.fps === 30);
    on('color', state.themeIdx !== 0);
    on('dim', state.dim);
    on('sync', state.sync);
    on('eq', state.eqEdit);
    on('preset', state.eqPreset !== 0);
    on('dsp', engine.dsp !== 0);
    on('motion', engine.motionIdx !== 0);
    on('illum', state.illumIdx !== 0);
    if (settingsUI && !settingsEl.hidden) settingsUI.refresh();
    tallyEls.forEach((el) => {
      const d = el.dataset;
      const lit = d.dsp !== undefined ? engine.dsp === +d.dsp : d.eq !== undefined ? state.eqPreset === +d.eq : state.speedIdx === +d.speed;
      el.classList.toggle('lit', lit && state.power);
    });
    on('tilt', Math.abs(panel.rest) > 0.4);
  }

  // ---- EQ ------------------------------------------------------------------
  function applyPreset(idx) {
    state.eqPreset = idx;
    state.eqGains.set(idx === USER_PRESET ? state.eqUser : EQ_PRESETS[idx].gains);
    engine.setEq(state.eqGains);
    scheduleSave();
  }

  function cyclePreset() {
    applyPreset((state.eqPreset + 1) % EQ_PRESETS.length);
    state.tempEqUntil = performance.now() + EQ_SHOW_MS;
    flash('EQ ' + EQ_PRESETS[state.eqPreset].name);
    syncUI();
  }

  // MOTION: how big the bars swing (NORMAL is the original range; LARGE is the default; HUGE is the most dramatic).
  // The order starts at LARGE so a press from the default goes bigger first.
  function cycleMotion() {
    const order = [1, 2, 0];
    engine.setMotion(order[(order.indexOf(engine.motionIdx) + 1) % order.length]);
    flash('MOTION ' + MOTIONS[engine.motionIdx].name);
    scheduleSave();
    syncUI();
  }

  function cycleDsp() {
    engine.setDsp((engine.dsp + 1) % DSP_NAMES.length);
    flash('DSP ' + DSP_NAMES[engine.dsp]);
    scheduleSave();
    syncUI();
  }

  function toggleEqEdit() {
    state.eqEdit = !state.eqEdit;
    state.tempEqUntil = 0;
    flash(state.eqEdit ? 'EQ EDIT: DRAG' : 'EQ EDIT END');
    syncUI();
  }

  function editEq(e) {
    refreshLayout(effectiveMode(performance.now())); // hit-testing needs the EQ layout even before the next frame
    const r = canvas.getBoundingClientRect();
    const hit = renderer.eqHit((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (!hit) return;
    if (state.eqPreset !== USER_PRESET) {
      state.eqUser.set(state.eqGains); // start the user curve from whatever was active
      state.eqPreset = USER_PRESET;
    }
    state.eqUser[hit.band] = hit.gain;
    state.eqGains.set(state.eqUser);
    engine.setEq(state.eqGains);
    flash('EQ ' + engine.eqLabels[hit.band] + ' ' + (hit.gain > 0 ? '+' : '') + hit.gain + 'DB', 900);
    scheduleSave();
    syncUI();
  }

  // ---- power / sources -----------------------------------------------------
  // The opening jingle, and the speaker hold that keeps a starting source quiet until the opening is over.
  function startOpeningAudio() {
    const t = Math.max(0, (performance.now() - state.bootStart) / 1000);
    if (!state.opening || reduceMotion || t >= OPENING.total) return;
    engine.holdOutput((OPENING.total - t) * 1000);
    engine.playOpening(t);
  }

  async function powerOn(initial) {
    if (state.power) return;
    engine.click('relay');
    state.power = true;
    state.bootStart = performance.now();
    state.autoNextAt = state.bootStart + (state.autoPattern + 4) * 1000; // after the opening
    scheduleSave();
    syncUI();
    try {
      await engine.init();
      engine.setEq(state.eqGains);
      startOpeningAudio();
      await selectSource(initial || 'demo');
      if (initial && !state.source) await selectSource('demo'); // the remembered input would not start: fall back
    } catch (err) {
      console.error(err);
      flash('AUDIO ERROR');
    }
  }

  function powerOff() {
    engine.click('relay');
    engine.stopOpening();
    engine.holdOutput(0);
    state.openHold = -1;
    state.byeUntil = performance.now() + 1100;
    state.sleepAt = 0;
    state.sleepMin = 0;
    engine.stopAll();
    state.power = false;
    state.source = null;
    state.eqEdit = false;
    state.tempEqUntil = 0;
    scheduleSave();
    syncUI();
  }

  async function selectSource(kind) {
    if (!state.power) return powerOn(kind);
    try {
      if (kind === 'demo') {
        await engine.useDemo();
        state.source = 'demo';
        flash('SRC DEMO');
      } else if (kind === 'mic') {
        await engine.useMic();
        state.source = 'mic';
        flash('SRC MIC');
        npFails = 0;
        pollNowPlaying();
      } else if (kind === 'tab') {
        await engine.useTab();
        state.source = 'tab';
        flash(NATIVE ? 'SRC SYS' : 'SRC TAB');
        npFails = 0;
        pollNowPlaying();
      } else if (kind === 'file') {
        if (!engine.hasFile()) {
          fileInput.click();
          return;
        }
        await engine.reuseFile();
        state.source = 'file';
        flash('SRC FILE');
      }
      if (state.problem && state.problem !== 'music') state.problem = ''; // the input works now
      if (state.source === 'mic' || state.source === 'tab') { if (state.lastSource !== state.source) { state.lastSource = state.source; scheduleSave(); } }
      else if (state.source === 'demo' && state.lastSource) { state.lastSource = ''; scheduleSave(); }
    } catch (err) {
      console.warn(err);
      const msg = String((err && err.message) || err);
      if (kind === 'mic') state.problem = 'mic';
      else if (kind === 'tab') state.problem = NATIVE ? (msg === 'unsupported' ? 'sys-old' : msg === 'denied' ? 'sys-denied' : 'sys-error') : msg === 'unsupported' ? 'tab-unsupported' : 'tab';
      if (kind === 'mic') flash('MIC ERROR');
      else if (kind === 'tab' && NATIVE) flash(msg === 'unsupported' ? 'SYS N/A' : msg === 'denied' ? 'ALLOW SYSTEM AUDIO' : 'SYS ERROR', 4500);
      else if (kind === 'tab') flash(msg === 'unsupported' ? 'TAB N/A' : msg === 'no-audio' ? 'NO TAB AUDIO' : 'TAB CANCELLED');
      else flash('PLAY ERROR');
    }
    syncUI();
  }

  // ---- now playing: optional local helper (server.py reads the Music app through AppleScript) ----
  const NP_URL = location.protocol === 'file:' ? 'http://127.0.0.1:8765/api/nowplaying' : '/api/nowplaying';
  let npTimer = null;
  let npFails = 0;
  let npWarned = '';

  async function pollNowPlaying() {
    clearTimeout(npTimer);
    if (location.protocol === 'https:' && !NATIVE) return; // a hosted copy has no local helper to ask
    let delay = 2000;
    if (state.power && (state.source === 'mic' || state.source === 'tab') && !document.hidden) {
      const ctrl = new AbortController();
      // the very first query can sit behind macOS's "allow control of Music?" dialog
      const abort = setTimeout(() => ctrl.abort(), 45000);
      try {
        const res = await fetch(NP_URL, { cache: 'no-store', signal: ctrl.signal });
        if (!res.ok) throw new Error('http ' + res.status);
        state.np = await res.json();
        state.npAt = performance.now();
        syncVolumeFromMusic();
        npFails = 0;
        const err = state.np.error;
        if (err === 'not-authorized' || err === 'timeout') {
          if (npWarned !== err) flash('ALLOW MUSIC ACCESS', 4500);
          npWarned = err;
          state.problem = 'music';
        } else {
          npWarned = '';
          if (state.problem === 'music') state.problem = '';
        }
      } catch (e) {
        state.np = null; // helper not running: the title line just stays empty
        npFails++;
        delay = Math.min(30000, 3000 * Math.pow(2, Math.min(npFails, 4)));
      }
      clearTimeout(abort);
    }
    npTimer = setTimeout(pollNowPlaying, delay);
  }

  engine.onTabEnded = () => {
    flash('TAB ENDED');
    selectSource('demo');
  };

  // ---- tracks (a dropped / opened set of files behaves like a disc) --------------------------
  const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|flac|m4a|aac|aif|aiff|webm|mp4)$/i;
  const isAudioFile = (f) => (f.type && f.type.indexOf('audio/') === 0) || AUDIO_EXT.test(f.name);

  async function loadFiles(list) {
    const files = Array.from(list || []).filter(isAudioFile);
    if (!files.length) {
      flash('NO AUDIO FILE');
      return;
    }
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    state.tracks = files;
    if (!state.power) {
      engine.click('relay');
      state.power = true;
      state.bootStart = performance.now();
      scheduleSave();
      await engine.init();
      engine.setEq(state.eqGains);
      startOpeningAudio();
    }
    flash('READING', 900);
    engine.click('loader');
    await new Promise((r) => setTimeout(r, 800));
    await playTrack(0);
  }

  function tagTitle(tags) {
    if (!tags || !tags.title) return '';
    return tags.artist ? tags.title + '  -  ' + tags.artist : tags.title;
  }

  async function playTrack(i) {
    const n = state.tracks.length;
    if (!n) return;
    state.trackIdx = ((i % n) + n) % n;
    const f = state.tracks[state.trackIdx];
    state.fileName = f.name.replace(/\.[^.]+$/, '');
    state.trackTitle = tagTitle(await readTags(f)); // '' when the file has no usable tags
    try {
      await engine.useFile(f);
      state.source = 'file';
      flash('TRK ' + pad2(state.trackIdx + 1));
    } catch (err) {
      console.warn(err);
      flash('PLAY ERROR');
    }
    syncUI();
  }

  // ---- transport keys -----------------------------------------------------------------------
  // With a file or the demo the keys drive the engine. With a live input (SYS / MIC) the music is in the Mac's Music
  // app, so the keys drive that app through the helper (POST /api/control) and the display follows its real state.
  const CONTROL_URL = location.protocol === 'file:' ? 'http://127.0.0.1:8765/api/control' : '/api/control';
  const isLive = () => state.source === 'mic' || state.source === 'tab';

  // Play / pause as far as we know: the Music app's own state for a live input, else the engine's.
  function isPlaying() {
    const i = state.np;
    if (isLive() && i && i.running && i.state && i.state !== 'unknown') {
      return i.state === 'playing' || i.state === 'fast forwarding' || i.state === 'rewinding';
    }
    return engine.isPlaying();
  }

  // Seconds into the current Music track (running between polls), or -1 when unknown.
  function musicTime(now) {
    const i = state.np;
    if (!i || !i.running || typeof i.position !== 'number' || !(i.duration > 0)) return -1;
    const p = i.position + (i.state === 'playing' ? (now - state.npAt) / 1000 : 0);
    return Math.max(0, Math.min(i.duration, p));
  }

  // VOL: with a live input the knob is the Music app's own volume. It follows the app when that changes (unless the
  // knob was just touched), and turning it writes the new level back (debounced).
  function syncVolumeFromMusic() {
    const i = state.np;
    if (!isLive() || !i || !i.running || typeof i.volume !== 'number') return;
    if (performance.now() - state.volTouchedAt < 2500) return;
    const v = Math.max(0, Math.min(1, i.volume / 100));
    if (Math.abs(v - knobs.vol.value) > 0.006) knobs.vol.set(v, true); // quiet: no write back, no OSD, not saved
  }

  let volTimer = null;
  function sendMusicVolume(v) {
    state.volTouchedAt = performance.now();
    clearTimeout(volTimer);
    volTimer = setTimeout(() => control('volume', Math.round(v * 100)), 120);
  }

  const CONTROL_LABEL = { next: 'NEXT TRACK', prev: 'PREV TRACK', restart: 'TRACK START', ff: 'FF', rw: 'REW' };

  async function control(action, value) {
    try {
      const res = await fetch(CONTROL_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-VFD-Control': '1' },
        body: JSON.stringify({ action, value }),
      });
      const j = await res.json();
      if (j.ok && action === 'volume') {
        if (state.np && state.np.running) state.np.volume = value; // no lamp, flash or refresh for the knob
        return true;
      }
      if (j.ok) {
        const now = performance.now();
        const i = state.np;
        if (i && i.running) {
          // move the lamp and the time at once; the refreshed poll below confirms it
          const t = musicTime(now);
          if (action === 'playpause') i.state = i.state === 'playing' ? 'paused' : 'playing';
          else if (action === 'ff') i.state = 'fast forwarding';
          else if (action === 'rw') i.state = 'rewinding';
          else if (action === 'resume') i.state = 'playing';
          if (action === 'next' || action === 'prev' || action === 'restart') i.position = 0;
          else if (t >= 0) i.position = t;
          state.npAt = now;
        }
        if (action === 'playpause') flash(isPlaying() ? 'PLAY' : 'PAUSE');
        else if (CONTROL_LABEL[action]) flash(CONTROL_LABEL[action]);
        syncUI();
        setTimeout(pollNowPlaying, 350);
        return true;
      }
      const text = { 'not-running': 'MUSIC NOT RUNNING', 'not-authorized': 'ALLOW MUSIC ACCESS', timeout: 'MUSIC NO REPLY' }[j.error];
      flash(text || 'MUSIC ERROR', j.error === 'not-authorized' ? 4500 : 2200);
    } catch (e) {
      flash('NO MUSIC HELPER', 2600); // opened in a plain browser without start.command / the Mac app
    }
    return false;
  }

  function nextTrack() {
    if (!state.power) return;
    if (isLive()) {
      control('next');
      return;
    }
    if (state.source !== 'file') {
      flash('NO TRACK');
      return;
    }
    if (state.tracks.length > 1) playTrack(state.trackIdx + 1);
    else engine.restartFile();
  }

  function prevTrack() {
    if (!state.power) return;
    if (isLive()) {
      // like a CD player: within the first seconds go to the previous track, later go back to the start of this one
      control(musicTime(performance.now()) >= 3 ? 'restart' : 'prev');
      return;
    }
    if (state.source !== 'file') {
      flash('NO TRACK');
      return;
    }
    if (state.tracks.length > 1 && engine.getTime() < 3) playTrack(state.trackIdx - 1);
    else engine.restartFile();
  }

  engine.onEnded = nextTrack;

  async function togglePlay() {
    if (!state.power) return powerOn();
    if (isLive()) {
      control('playpause');
      return;
    }
    if (!state.source) {
      await selectSource('demo'); // nothing selected yet: PLAY starts the built-in demo
      return;
    }
    await engine.togglePlay();
    flash(engine.isPlaying() ? 'PLAY' : 'PAUSE');
    syncUI();
  }

  // ---- display settings ----------------------------------------------------
  function cycleMode() {
    state.modeIdx = (state.modeIdx + 1) % MODES.length;
    state.autoNextAt = performance.now() + state.autoPattern * 1000; // a pattern you pick stays for a full interval
    state.eqEdit = false;
    state.tempEqUntil = 0;
    flash(MODES[state.modeIdx].label);
    scheduleSave();
    syncUI();
  }

  function cycleBands() {
    const n = BAND_CYCLE[engine.bandCount];
    engine.setBandCount(n);
    model.resize(n);
    flash(n + ' BAND');
    scheduleSave();
    syncUI();
  }

  function applySpeed() {
    const { decayTau, peakHold, peakGravity } = SPEEDS[state.speedIdx];
    Object.assign(model.opt, { decayTau, peakHold, peakGravity });
  }

  function cycleSpeed() {
    state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
    applySpeed();
    flash('SPEED ' + SPEEDS[state.speedIdx].name);
    scheduleSave();
    syncUI();
  }

  function toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => flash('FULLSCREEN N/A'));
  }

  function toggleKeySound() {
    engine.uiSound = !engine.uiSound;
    flash(engine.uiSound ? 'KEY SOUND ON' : 'KEY SOUND OFF');
    scheduleSave();
  }

  function toggleAgc() {
    engine.agc = !engine.agc;
    flash(engine.agc ? 'AGC ON' : 'AGC OFF');
    scheduleSave();
    syncUI();
  }

  function applyTheme() {
    const t = THEMES[state.themeIdx];
    renderer.setTheme(t);
    const illum = ILLUMS[state.illumIdx];
    const illumRgb = (illum.custom ? hslRgb(state.illumHue, 1, 0.62) : illum.rgb || t.illum).join(', ');
    faceplate.style.setProperty('--illum', illumRgb);
    document.documentElement.style.setProperty('--accent', illumRgb); // the settings screen wears the panel's colour
    faceplate.style.setProperty('--glow', t.text.join(', '));
  }

  function cycleIllum() {
    state.illumIdx = (state.illumIdx + 1) % ILLUMS.length;
    applyTheme();
    flash('ILLUM ' + ILLUMS[state.illumIdx].name);
    scheduleSave();
    syncUI();
    refreshPalette();
  }

  function cycleTheme(dir) {
    state.themeIdx = (state.themeIdx + (dir || 1) + THEMES.length) % THEMES.length;
    applyTheme();
    flash('COLOR ' + THEMES[state.themeIdx].id);
    scheduleSave();
    syncUI();
    refreshPalette();
  }

  // 13-step display dimmer (as on the real units): level 13 is full brightness. The DIM key switches between full
  // and the chosen night level; the wheel over the display steps the level.
  const dimGain = () => (state.dim ? 0.2 + 0.8 * Math.pow((state.dimLevel - 1) / 12, 1.2) : 1);

  function applyDim() {
    faceplate.style.setProperty('--dimf', (0.3 + 0.7 * dimGain()).toFixed(3));
    syncUI();
  }

  function toggleDim() {
    if (state.dim) state.dim = false;
    else {
      if (state.dimLevel >= 13) state.dimLevel = 7;
      state.dim = true;
    }
    flash(state.dim ? 'DIMMER ' + pad2(state.dimLevel) : 'DIMMER OFF');
    scheduleSave();
    applyDim();
  }

  function stepDim(dir) {
    state.dimLevel = Math.min(13, Math.max(1, state.dimLevel + dir));
    state.dim = state.dimLevel < 13;
    flash('DIMMER ' + (state.dim ? pad2(state.dimLevel) : 'OFF'));
    scheduleSave();
    applyDim();
  }

  function toggleSync() {
    state.sync = !state.sync;
    flash(state.sync ? 'SYNC ON' : 'SYNC OFF');
    scheduleSave();
    syncUI();
  }

  function toggleFps() {
    state.fps = state.fps === 30 ? 60 : 30;
    flash(state.fps + ' FPS');
    scheduleSave();
    syncUI();
  }

  // ---- motorised panel: tilt presets, retract when off, and the flip-down "OPEN" movement ----
  const dash = document.querySelector('.dash');
  const PANEL_TILTS = [0, 8, -5]; // degrees: flat / leaning back / leaning forward
  const PANEL_RETRACT = 12; // unit switched off: the panel tucks back
  const PANEL_MIN = -8; // ANGLE keys: limits of travel
  const PANEL_MAX = 22;
  const ANGLE_DEG_PER_SEC = 14;
  const PANEL_OPEN = -72; // flipped down (top edge toward the viewer), exposing the mechanism
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const panel = { angle: PANEL_RETRACT, from: 0, to: 0, t0: 0, dur: 0, raf: 0, resolvers: [], open: false, tiltIdx: savedTilt, rest: PANEL_TILTS[savedTilt] };
  if (typeof prefs.panelAngle === 'number' && prefs.panelAngle >= PANEL_MIN && prefs.panelAngle <= PANEL_MAX) panel.rest = prefs.panelAngle;

  function setPanelAngle(a) {
    panel.angle = a;
    faceplate.style.setProperty('--panel-rot', a.toFixed(2));
    faceplate.style.setProperty('--tiltf', (Math.max(-9, Math.min(9, a)) / 10).toFixed(3));
    const flipped = a < -12; // only the OPEN movement goes this far; TILT / ANGLE stay within -8..+22 and keep the keys live
    faceplate.classList.toggle('flipping', flipped);
    dash.dataset.open = flipped ? '1' : '0';
  }

  // trapezoidal velocity profile: accelerate, cruise, decelerate (25% / 50% / 25%)
  function trapezoid(u) {
    const a = 0.25;
    const vmax = 1 / (1 - a);
    if (u < a) return (0.5 * vmax * u * u) / a;
    if (u > 1 - a) {
      const r = 1 - u;
      return 1 - (0.5 * vmax * r * r) / a;
    }
    return vmax * (u - a / 2);
  }

  // Advances the motor to time `now`; returns true while it is still moving or settling.
  function panelUpdate(now) {
    const elapsed = now - panel.t0;
    if (elapsed < panel.dur) {
      setPanelAngle(panel.from + (panel.to - panel.from) * trapezoid(elapsed / panel.dur));
      return true;
    }
    const s = (elapsed - panel.dur) / 1000;
    if (s < 0.4) {
      // the mechanism settles against its stops with a small damped wobble
      setPanelAngle(panel.to + Math.sign(panel.to - panel.from) * 0.8 * Math.sin(s * 2 * Math.PI * 7) * Math.exp(-s * 9));
      return true;
    }
    setPanelAngle(panel.to);
    panel.resolvers.splice(0).forEach((r) => r());
    return false;
  }

  function panelTick(now) {
    panel.raf = 0;
    if (panelUpdate(now)) panel.raf = requestAnimationFrame(panelTick);
  }

  function movePanel(target, degPerSec) {
    return new Promise((resolve) => {
      const dist = Math.abs(target - panel.angle);
      if (reduceMotion || dist < 0.05) {
        setPanelAngle(target);
        resolve();
        return;
      }
      panel.from = panel.angle;
      panel.to = target;
      panel.t0 = performance.now();
      panel.dur = 300 + (dist / degPerSec) * 1000;
      panel.resolvers.push(resolve);
      engine.click('servo', panel.dur);
      if (!panel.raf) panel.raf = requestAnimationFrame(panelTick);
    });
  }

  const restAngle = () => (state.power ? panel.rest : PANEL_RETRACT);

  function cycleTilt() {
    panel.tiltIdx = (panel.tiltIdx + 1) % PANEL_TILTS.length;
    panel.rest = PANEL_TILTS[panel.tiltIdx];
    flash('TILT ' + (panel.tiltIdx + 1));
    scheduleSave();
    syncUI();
    if (!panel.open) movePanel(panel.rest, 16);
  }

  // ANGLE keys: the motor runs while the key is held and stops on release; the position is remembered.
  function holdPanel(angle) {
    panel.from = panel.to = angle;
    panel.t0 = performance.now() - panel.dur - 1000; // cancels a running move: it is already "finished" at `angle`
    setPanelAngle(angle);
  }

  function nudgePanel(deg) {
    panel.rest = Math.min(PANEL_MAX, Math.max(PANEL_MIN, panel.rest + deg));
    holdPanel(panel.rest);
  }

  const angleText = () => 'ANGLE ' + (panel.rest > 0.4 ? '+' : '') + panel.rest.toFixed(0);

  function bindAngle(el, dir) {
    let timer = null;
    let last = 0;
    let lastSound = 0;
    let downAt = 0;
    const nudge = nudgePanel;
    const run = () => {
      if (!state.power || panel.open) {
        // powered off or flipped open while the key is held: let the retract / open move take over
        clearInterval(timer);
        timer = null;
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const before = panel.rest;
      nudge(dir * ANGLE_DEG_PER_SEC * dt);
      if (panel.rest !== before && now - lastSound > 420) {
        lastSound = now;
        engine.click('servo', 480, 'nolatch');
      }
    };
    const stop = () => {
      el.classList.remove('on');
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      if (performance.now() - downAt < 250) nudge(dir * 1.5); // a tap moves it a notch
      panel.tiltIdx = Math.max(0, PANEL_TILTS.indexOf(Math.round(panel.rest))); // TILT lamp follows the preset it landed on
      flash(angleText());
      scheduleSave();
      syncUI();
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !state.power || panel.open || timer) return;
      downAt = last = performance.now();
      lastSound = 0;
      el.classList.add('on'); // lamp lit while the motor runs
      timer = setInterval(run, 33);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => el.addEventListener(t, stop));
  }
  document.querySelectorAll('[data-angle]').forEach((el) => bindAngle(el, Number(el.dataset.angle)));

  // OPEN: the panel folds down like on a flip-face deck; the chooser opens straight away (it needs the click's
  // user activation) and the panel closes again once files are picked or the chooser is dismissed.
  function openTray() {
    if (panel.open) {
      closeTray();
      return;
    }
    panel.open = true;
    fileInput.click();
    movePanel(PANEL_OPEN, 42);
  }

  function closeTray() {
    if (!panel.open) return;
    panel.open = false;
    movePanel(restAngle(), 42);
  }

  $('#cavity').addEventListener('click', closeTray);
  fileInput.addEventListener('cancel', closeTray);
  window.addEventListener('focus', () => {
    if (!panel.open) return;
    // browsers without a 'cancel' event: the window regains focus when the chooser closes
    setTimeout(() => {
      if (panel.open && !fileInput.files.length) closeTray();
    }, 900);
  });

  // The pinhole: every setting back to factory default (and the stored ones forgotten); a running unit reboots.
  function resetUnit() {
    engine.click('relay');
    state.modeIdx = 0;
    state.eqEdit = false;
    state.tempEqUntil = 0;
    state.osdUntil = 0;
    engine.setBandCount(15);
    model.resize(15);
    state.customHue = 200;
    state.customSat = 100;
    state.illumHue = 30;
    THEMES[CUSTOM_THEME] = hueTheme('CUSTOM', 200, 1);
    state.themeIdx = 0;
    applyTheme();
    setPalette(false);
    state.speedIdx = 0;
    applySpeed();
    state.dim = false;
    state.dimLevel = 7;
    state.sync = false;
    state.fps = 30;
    engine.agc = true;
    engine.uiSound = true;
    state.eqUser.fill(0);
    state.eqPreset = 0;
    state.eqGains.set(EQ_PRESETS[0].gains);
    engine.setEq(state.eqGains);
    engine.setDsp(0);
    engine.setMotion(AudioEngine.MOTION_DEFAULT);
    state.theater = false;
    document.body.classList.remove('theater');
    state.illumIdx = 0;
    state.opening = true;
    state.autoStart = true;
    state.autoPattern = 0;
    state.keepAwake = true;
    state.sleepAt = 0;
    state.sleepMin = 0;
    applyTheme();
    refreshPalette();
    knobs.vol.set(0.7, true);
    knobs.sens.set(0.5, true);
    panel.tiltIdx = 0;
    panel.rest = PANEL_TILTS[0];
    if (!panel.open) movePanel(restAngle(), 16);
    if (state.power) {
      state.bootStart = performance.now(); // the whole opening again
      engine.stopOpening();
      startOpeningAudio();
    }
    clearTimeout(saveTimer);
    state.lastSource = '';
    try { localStorage.removeItem(PREFS_KEY); } catch (e) { /* storage blocked */ }
    if (NATIVE) { try { window.webkit.messageHandlers.vfd.postMessage({ cmd: 'clearPrefs' }); } catch (e) { /* no bridge */ } }
    applyDim();
  }

  // Operating instructions: closed until asked for (button under the unit, or H / ?), so the unit can fill the window.
  const helpEl = $('#help');
  const paletteEl = $('#palette');
  const helpBtn = document.querySelector('.help-toggle');
  const paletteBtn = document.querySelector('.palette-toggle');
  function setHelp(open) {
    helpEl.hidden = !open;
    helpBtn.setAttribute('aria-expanded', String(open));
    if (open) setPalette(false);
  }
  function setPalette(open) {
    paletteEl.hidden = !open;
    paletteBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      setHelp(false);
      refreshPalette();
    }
  }
  $('#help-close').addEventListener('click', () => setHelp(false));
  $('#palette-close').addEventListener('click', () => setPalette(false));
  document.addEventListener('pointerdown', (e) => {
    // a press anywhere else closes an open panel
    if ((!helpEl.hidden || !paletteEl.hidden) && !e.target.closest('#help, #palette, #settings, .dock')) {
      setHelp(false);
      setPalette(false);
    }
  }, true);

  // ---- settings screen ----------------------------------------------------------------------------------
  // Direct setters: the panel's keys cycle through these same states, and the settings screen sets them by value.
  const COLOR_JA = {
    CYAN: 'シアン', GREEN: 'グリーン', AMBER: 'アンバー', ICE: 'アイス', ROSE: 'ローズ', VIOLET: 'バイオレット', CROSS: 'クロス',
    RED: '赤', ORANGE: 'オレンジ', YELLOW: '黄', LIME: 'ライム', MINT: 'ミント', SKY: 'スカイ', BLUE: '青', INDIGO: '藍',
    MAGENTA: 'マゼンタ', WHITE: '白', RAINBOW: '虹色', SPECTRUM: 'スペクトラム', SUNSET: '夕焼け', OCEAN: '海', FIRE: '炎',
    AURORA: 'オーロラ', NEON: 'ネオン', CUSTOM: 'カスタム', AUTO: '自動', PURPLE: 'パープル', PINK: 'ピンク',
  };

  function setMode(i) {
    if (!MODES[i]) return;
    state.modeIdx = i;
    state.autoNextAt = performance.now() + state.autoPattern * 1000; // a pattern you pick stays for a full interval
    state.eqEdit = false;
    state.tempEqUntil = 0;
    flash(MODES[i].label);
    scheduleSave();
    syncUI();
  }

  function setBands(n) {
    if (!BAND_CYCLE[n] || n === engine.bandCount) return;
    engine.setBandCount(n);
    model.resize(n);
    flash(n + ' BAND');
    scheduleSave();
    syncUI();
  }

  function setSpeed(i) {
    if (!SPEEDS[i]) return;
    state.speedIdx = i;
    applySpeed();
    flash('SPEED ' + SPEEDS[i].name);
    scheduleSave();
    syncUI();
  }

  function setMotionIdx(i) {
    if (!MOTIONS[i]) return;
    engine.setMotion(i);
    flash('MOTION ' + MOTIONS[i].name);
    scheduleSave();
    syncUI();
  }

  function setBrightness(level) {
    state.dimLevel = Math.max(1, Math.min(13, level));
    state.dim = state.dimLevel < 13;
    flash('DIMMER ' + (state.dim ? pad2(state.dimLevel) : 'OFF'));
    scheduleSave();
    applyDim();
  }

  function setFps(n) {
    state.fps = n === 60 ? 60 : 30;
    flash(state.fps + ' FPS');
    scheduleSave();
    syncUI();
  }

  function setAgc(on) {
    engine.agc = !!on;
    flash(engine.agc ? 'AGC ON' : 'AGC OFF');
    scheduleSave();
    syncUI();
  }

  function setSync(on) {
    state.sync = !!on;
    flash(state.sync ? 'SYNC ON' : 'SYNC OFF');
    scheduleSave();
    syncUI();
  }

  function setKeySound(on) {
    engine.uiSound = !!on;
    flash(engine.uiSound ? 'KEY SOUND ON' : 'KEY SOUND OFF');
    scheduleSave();
  }

  function setPresetIdx(i) {
    if (!EQ_PRESETS[i]) return;
    applyPreset(i);
    state.tempEqUntil = performance.now() + EQ_SHOW_MS;
    flash('EQ ' + EQ_PRESETS[i].name);
    syncUI();
  }

  function setDspIdx(i) {
    if (!DSP_NAMES[i]) return;
    engine.setDsp(i);
    flash('DSP ' + DSP_NAMES[i]);
    scheduleSave();
    syncUI();
  }

  function setAngle(deg, smooth) {
    panel.rest = Math.min(PANEL_MAX, Math.max(PANEL_MIN, deg));
    panel.tiltIdx = Math.max(0, PANEL_TILTS.indexOf(Math.round(panel.rest)));
    if (state.power && !panel.open) {
      if (smooth) movePanel(panel.rest, 16);
      else holdPanel(panel.rest);
    }
    flash(angleText());
    scheduleSave();
    syncUI();
  }

  function setKeepOnTop(on) {
    state.keepOnTop = !!on;
    if (NATIVE) window.webkit.messageHandlers.vfd.postMessage({ cmd: 'keepOnTop', value: state.keepOnTop });
  }
  // the Mac app tells us when its menu changes it
  window.vfdNative = window.vfdNative || {};
  window.vfdNative.keepOnTop = (on) => {
    state.keepOnTop = !!on;
    if (settingsUI) settingsUI.refresh();
  };

  // ---- ready-made looks: colour, pattern, bars, motion and brightness in one go ---------------------------
  const LOOKS = [
    { id: 'classic', tag: 'CLASSIC', name: 'クラシック', note: '定番のシアン', theme: 'CYAN', illum: 'AUTO', mode: 'bar', bands: 15, motion: 1, brightness: 13, sync: false },
    { id: 'violetfan', tag: 'VIOLET FAN', name: 'バイオレット遠近', note: '紫の遠近スペアナ', theme: 'VIOLET', illum: 'PURPLE', mode: 'fan', bands: 15, motion: 1, brightness: 13, sync: false },
    { id: 'night', tag: 'NIGHT', name: 'ナイトドライブ', note: '暗めのアンバー', theme: 'AMBER', illum: 'AMBER', mode: 'mirror', bands: 13, motion: 0, brightness: 8, sync: false },
    { id: 'party', tag: 'PARTY', name: 'パーティー', note: '虹色で激しく動く', theme: 'RAINBOW', illum: 'MAGENTA', mode: 'center', bands: 15, motion: 2, brightness: 13, sync: true },
    { id: 'ocean', tag: 'OCEAN', name: 'オーシャン', note: '深い青のグラデーション', theme: 'OCEAN', illum: 'SKY', mode: 'bar', bands: 13, motion: 1, brightness: 13, sync: false },
    { id: 'sunset', tag: 'SUNSET', name: 'サンセット', note: '紫から金色へ', theme: 'SUNSET', illum: 'PINK', mode: 'bar', bands: 15, motion: 1, brightness: 13, sync: false },
    { id: 'minimal', tag: 'MINIMAL', name: 'ミニマル', note: '白の 9 本、静かに', theme: 'WHITE', illum: 'WHITE', mode: 'peak', bands: 9, motion: 0, brightness: 10, sync: false },
    { id: 'scope', tag: 'SCOPE', name: 'オシロスコープ', note: '緑の波形表示', theme: 'GREEN', illum: 'GREEN', mode: 'scope', bands: 15, motion: 1, brightness: 13, sync: false },
  ];
  const lookParts = (L) => ({
    theme: THEMES.findIndex((t) => t.id === L.theme),
    illum: ILLUMS.findIndex((x) => x.name === L.illum),
    mode: MODES.findIndex((m) => m.id === L.mode),
  });

  function applyLook(id) {
    const L = LOOKS.find((l) => l.id === id);
    if (!L) return;
    const p = lookParts(L);
    if (p.theme >= 0) state.themeIdx = p.theme;
    if (p.illum >= 0) state.illumIdx = p.illum;
    applyTheme();
    refreshPalette();
    if (p.mode >= 0) setMode(p.mode);
    setBands(L.bands);
    setMotionIdx(L.motion);
    state.sync = L.sync;
    setBrightness(L.brightness);
    flash('STYLE ' + L.tag);
    scheduleSave();
    syncUI();
  }

  // the look that matches what is on the display right now ('' once anything was changed by hand)
  function currentLook() {
    const hit = LOOKS.find((L) => {
      const p = lookParts(L);
      return p.theme === state.themeIdx && p.illum === state.illumIdx && p.mode === state.modeIdx && L.bands === engine.bandCount && L.motion === engine.motionIdx;
    });
    return hit ? hit.id : '';
  }

  // sleep timer: switches the unit off after `min` minutes (the Mac keeps playing; only the display goes dark)
  function setSleep(min) {
    if (!state.power) return;
    state.sleepMin = min > 0 ? min : 0;
    state.sleepAt = min > 0 ? performance.now() + min * 60000 : 0;
    state.sleepWarned = false;
    flash(min > 0 ? 'SLEEP ' + min + ' MIN' : 'SLEEP OFF', 2200);
    syncUI();
  }

  function setAutoPattern(sec) {
    state.autoPattern = sec > 0 ? sec : 0;
    state.autoNextAt = performance.now() + state.autoPattern * 1000;
    flash(state.autoPattern ? 'AUTO ' + state.autoPattern + 'S' : 'AUTO OFF');
    scheduleSave();
    syncUI();
  }

  const api = {
    native: NATIVE,
    canTabCapture: AudioEngine.tabCaptureSupported(),
    modes: MODES.map((m) => m.id),
    get() {
      return {
        mode: state.modeIdx,
        bands: engine.bandCount,
        motion: engine.motionIdx,
        speed: state.speedIdx,
        brightness: state.dim ? state.dimLevel : 13,
        agc: engine.agc,
        sens: Math.round((knobs.sens.value - 0.5) * 24),
        sync: state.sync,
        fps: state.fps,
        theater: state.theater,
        volume: knobs.vol.value,
        eqPreset: state.eqPreset,
        dsp: engine.dsp,
        keySound: engine.uiSound,
        opening: state.opening,
        source: state.source,
        live: isLive(),
        angle: panel.rest,
        themeName: COLOR_JA[THEMES[state.themeIdx].id] || THEMES[state.themeIdx].id,
        illumName: COLOR_JA[ILLUMS[state.illumIdx].name] || ILLUMS[state.illumIdx].name,
        autoStart: state.autoStart,
        keepOnTop: state.keepOnTop,
        wakeLockSupported: WAKE_LOCK,
        keepAwake: state.keepAwake,
        canTab: AudioEngine.tabCaptureSupported(),
        look: currentLook(),
        problem: state.problem,
        autoPattern: state.autoPattern,
        sleepMin: state.sleepAt ? state.sleepMin : 0,
        sleepLeft: state.sleepAt ? Math.max(0, state.sleepAt - performance.now()) / 60000 : 0,
        power: state.power,
      };
    },
    looks: () => LOOKS.map((L) => ({ id: L.id, name: L.name, note: L.note, gradient: themeGradient(THEMES[lookParts(L).theme]) })),
    applyLook,
    setSleep,
    setAutoPattern,
    setKeepAwake: (on) => {
      state.keepAwake = !!on;
      updateWakeLock();
      scheduleSave();
      syncUI();
    },
    openPrivacy: (pane) => { if (NATIVE) window.webkit.messageHandlers.vfd.postMessage({ cmd: 'openPrivacy', pane }); },
    setMode,
    setBands,
    setMotion: setMotionIdx,
    setSpeed,
    setBrightness,
    setAgc,
    setSens: (db) => knobs.sens.set((db + 12) / 24),
    setSync,
    setFps,
    setTheater: (on) => setTheater(!!on),
    setVolume: (v) => knobs.vol.set(v),
    setPreset: setPresetIdx,
    toggleEqEdit: () => state.power && toggleEqEdit(),
    setDsp: setDspIdx,
    setKeySound,
    setOpening: (on) => {
      state.opening = !!on;
      flash('OPENING ' + (state.opening ? 'ON' : 'OFF'));
      scheduleSave();
      syncUI();
    },
    selectSource: (kind) => selectSource(kind),
    transport: (which) => (which === 'play' ? togglePlay() : which === 'next' ? nextTrack() : prevTrack()),
    setAngle,
    setKeepOnTop,
    setAutoStart: (on) => {
      state.autoStart = !!on;
      scheduleSave();
      syncUI();
    },
    openPalette: () => setPalette(true),
    openHelp: () => setHelp(true),
    reset: () => resetUnit(),
  };

  settingsEl = $('#settings');
  settingsUI = createSettings(api, settingsEl);
  const settingsBtn = document.querySelector('.settings-toggle');
  function setSettings(open) {
    settingsEl.hidden = !open;
    document.body.classList.toggle('settings-open', open);
    settingsBtn.setAttribute('aria-expanded', String(open));
    if (open) settingsUI.refresh();
  }
  settingsUI.closeButton.addEventListener('click', () => setSettings(false));

  // ---- colour palette: every display theme and key-illumination colour as a swatch, plus hue sliders for a
  // custom display colour and a custom key colour -----------------------------------------------------------
  const rgbCss = (c) => 'rgb(' + c.join(',') + ')';
  function themeGradient(t) {
    if (t.rainbow) {
      const hues = [0, 1, 2, 3, 4, 5, 6].map((k) => rgbCss(hslRgb(t.rainbow.h0 + (t.rainbow.span * k) / 6, 1, 0.55)));
      return 'linear-gradient(90deg,' + hues.join(',') + ')';
    }
    if (t.stops) return 'linear-gradient(90deg,' + t.stops.map((p) => rgbCss(p[1]) + ' ' + Math.round(p[0] * 100) + '%').join(',') + ')';
    return 'linear-gradient(90deg,' + rgbCss(t.lo) + ' 0%,' + rgbCss(t.hi) + ' 74%,' + rgbCss(t.warn) + ' 82%,' + rgbCss(t.hot) + ' 100%)';
  }

  const swDisplay = $('#sw-display');
  const swIllum = $('#sw-illum');
  function swatch(label, background, onPick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.title = label;
    b.innerHTML = '<i></i><span></span>';
    b.firstChild.style.background = background;
    b.lastChild.textContent = label;
    b.addEventListener('click', onPick);
    return b;
  }

  function pickTheme(i) {
    state.themeIdx = i;
    applyTheme();
    flash('COLOR ' + THEMES[i].id);
    scheduleSave();
    syncUI();
    refreshPalette();
  }

  function pickIllum(i) {
    state.illumIdx = i;
    applyTheme();
    flash('ILLUM ' + ILLUMS[i].name);
    scheduleSave();
    syncUI();
    refreshPalette();
  }

  function buildPalette() {
    swDisplay.innerHTML = '';
    THEMES.forEach((t, i) => swDisplay.appendChild(swatch(t.id, themeGradient(t), () => pickTheme(i))));
    swIllum.innerHTML = '';
    ILLUMS.forEach((e, i) => {
      const bg = e.custom ? 'rgb(' + hslRgb(state.illumHue, 1, 0.62).join(',') + ')'
        : e.rgb ? rgbCss(e.rgb) : 'repeating-linear-gradient(45deg,#3a3c40 0 4px,#585b61 4px 8px)';
      swIllum.appendChild(swatch(e.name, bg, () => pickIllum(i)));
    });
  }

  function refreshPalette() {
    Array.from(swDisplay.children).forEach((b, i) => b.classList.toggle('sel', i === state.themeIdx));
    Array.from(swIllum.children).forEach((b, i) => b.classList.toggle('sel', i === state.illumIdx));
    if (swDisplay.children[CUSTOM_THEME]) swDisplay.children[CUSTOM_THEME].firstChild.style.background = themeGradient(THEMES[CUSTOM_THEME]);
    if (swIllum.children[CUSTOM_ILLUM]) swIllum.children[CUSTOM_ILLUM].firstChild.style.background = 'rgb(' + hslRgb(state.illumHue, 1, 0.62).join(',') + ')';
    $('#hue-display').value = state.customHue;
    $('#sat-display').value = state.customSat;
    $('#hue-illum').value = state.illumHue;
  }

  // the sliders: any move selects the custom colour; rebuilding the display theme is coalesced to ~30 ms
  let sliderTimer = null;
  const onSlider = (fn) => () => {
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(fn, 30);
  };
  const displaySlider = onSlider(() => {
    state.customHue = +$('#hue-display').value;
    state.customSat = +$('#sat-display').value;
    THEMES[CUSTOM_THEME] = hueTheme('CUSTOM', state.customHue, state.customSat / 100);
    state.themeIdx = CUSTOM_THEME;
    applyTheme();
    scheduleSave();
    syncUI();
    refreshPalette();
  });
  const illumSlider = onSlider(() => {
    state.illumHue = +$('#hue-illum').value;
    state.illumIdx = CUSTOM_ILLUM;
    applyTheme();
    scheduleSave();
    syncUI();
    refreshPalette();
  });
  $('#hue-display').addEventListener('input', displaySlider);
  $('#sat-display').addEventListener('input', displaySlider);
  $('#hue-illum').addEventListener('input', illumSlider);

  // Display-only view: the controls step aside and the display takes the whole window (Z, or the dock button).
  function setTheater(on) {
    state.theater = on;
    document.body.classList.toggle('theater', on);
    wakePointer();
    flash(on ? 'DISPLAY ONLY' : 'FULL PANEL');
    scheduleSave();
  }

  const whenOn = (fn) => () => state.power && fn();
  const actions = {
    reset: resetUnit,
    power: () => (state.power ? powerOff() : powerOn()),
    'src-demo': () => selectSource('demo'),
    'src-mic': () => selectSource('mic'),
    'src-tab': () => selectSource('tab'),
    'src-file': () => selectSource('file'),
    play: togglePlay,
    mode: whenOn(cycleMode),
    band: whenOn(cycleBands),
    speed: whenOn(cycleSpeed),
    fullscreen: toggleFullscreen,
    keysound: () => state.power && toggleKeySound(),
    agc: whenOn(toggleAgc),
    fps: whenOn(toggleFps),
    color: whenOn(cycleTheme),
    dim: whenOn(toggleDim),
    sync: whenOn(toggleSync),
    eq: whenOn(toggleEqEdit),
    preset: whenOn(cyclePreset),
    dsp: whenOn(cycleDsp),
    theater: () => setTheater(!state.theater),
    illum: whenOn(cycleIllum),
    motion: whenOn(cycleMotion),
    help: () => setHelp(helpEl.hidden),
    palette: () => setPalette(paletteEl.hidden),
    settings: () => setSettings(settingsEl.hidden),
    tilt: whenOn(cycleTilt),
    eject: openTray,
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const fn = actions[btn.dataset.action];
    if (fn) fn();
    if (e.detail > 0) btn.blur();
  });

  // Tap = change track, hold = wind (like a car stereo's seek keys).
  function bindHold(el, dir) {
    let armed = false;
    let held = false;
    let timer = null;
    let repeat = null;
    let ticks = 0;
    let winding = false; // the Music app is fast-forwarding / rewinding and must be told to resume
    const stop = () => {
      clearTimeout(timer);
      clearInterval(repeat);
      timer = repeat = null;
      if (winding) {
        winding = false;
        control('resume');
      }
    };
    const wind = () => {
      if (!state.power) return;
      if (isLive()) {
        if (!winding) {
          winding = true;
          control(dir < 0 ? 'rw' : 'ff');
        }
      } else if (state.source === 'file') {
        engine.seek(dir * HOLD_SEEK_SEC * Math.min(4, 1 + Math.floor(ticks / 8)));
      }
      ticks++;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      armed = true;
      held = false;
      ticks = 0;
      timer = setTimeout(() => {
        held = true;
        wind();
        repeat = setInterval(wind, HOLD_REPEAT_MS);
      }, HOLD_MS);
    });
    el.addEventListener('pointerup', () => {
      const tap = armed && !held;
      stop();
      armed = held = false;
      if (tap) (dir < 0 ? prevTrack : nextTrack)();
      el.blur();
    });
    const cancel = () => {
      stop();
      armed = held = false;
    };
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
  }
  bindHold($('[data-hold="prev"]'), -1);
  bindHold($('[data-hold="next"]'), 1);

  // In the display-only view and in full screen the mouse pointer goes away after a few idle seconds.
  let idleTimer = null;
  const wakePointer = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    if (state.theater || document.fullscreenElement) idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  };
  document.addEventListener('pointermove', wakePointer, { passive: true });
  document.addEventListener('fullscreenchange', wakePointer);

  // Any click or key press during the opening skips to the end.
  let swallowClick = false;
  function skipOpening(e) {
    const t = openingTime(performance.now());
    if (t < 0.35) return; // not opening, or only just started (the click that switched the unit on)
    state.bootStart = performance.now() - OPEN_MS - 1;
    state.openHold = -1;
    engine.stopOpening();
    engine.releaseOutput();
    if (e && e.target && e.target.closest && e.target.closest('.glass')) {
      swallowClick = true; // the click that skipped must not also change the display pattern
      setTimeout(() => (swallowClick = false), 500);
    }
  }
  document.addEventListener('pointerdown', skipOpening, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') skipOpening(e);
  }, true);

  // Clicking the display cycles the display pattern; in the EQ editor it edits instead.
  let eqDrag = false;
  glass.addEventListener('pointerdown', (e) => {
    if (!state.power || effectiveMode(performance.now()).kind !== 'eq') return;
    state.eqEdit = true;
    state.tempEqUntil = 0;
    eqDrag = true;
    faceplate.style.setProperty('--tilt', '0');
    try { glass.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    editEq(e);
    e.preventDefault();
  });
  glass.addEventListener('pointermove', (e) => {
    if (eqDrag) editEq(e);
  });
  const endEqDrag = () => {
    eqDrag = false;
    faceplate.style.setProperty('--tilt', '1');
  };
  glass.addEventListener('pointerup', endEqDrag);
  glass.addEventListener('pointercancel', endEqDrag);
  glass.addEventListener('wheel', (e) => {
    if (!state.power) return;
    e.preventDefault();
    stepDim(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  glass.addEventListener('click', () => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (!state.power) powerOn();
    else if (effectiveMode(performance.now()).kind !== 'eq') cycleMode();
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    closeTray();
    loadFiles(files);
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  // tactile feedback: keys click on press and again (softer) on release
  const parTarget = { x: 0, y: 0 }; // viewer position, -1..1 (drives the mesh/filament parallax)
  const par = { x: 0, y: 0 };
  const KEY_SELECTOR = '.btn, .power, .eject, .reset';
  document.addEventListener('pointerdown', (e) => {
    engine.unlockUi();
    engine.resume();
    if (e.target.closest(KEY_SELECTOR)) engine.click('down');
  }, { passive: true });
  document.addEventListener('pointerup', (e) => {
    if (e.target.closest(KEY_SELECTOR)) engine.click('up');
  }, { passive: true });

  // The glass sits in front of the phosphor, and the whole unit tilts a hair toward the viewer's pointer:
  // both are driven by --mx / --my (written at most once per frame).
  let pointer = null;
  let pointerQueued = false;
  document.addEventListener('pointermove', (e) => {
    pointer = e;
    parTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
    parTarget.y = (e.clientY / window.innerHeight) * 2 - 1;
    if (pointerQueued) return;
    pointerQueued = true;
    requestAnimationFrame(() => {
      pointerQueued = false;
      faceplate.style.setProperty('--mx', ((pointer.clientX / window.innerWidth) * 2 - 1).toFixed(3));
      faceplate.style.setProperty('--my', ((pointer.clientY / window.innerHeight) * 2 - 1).toFixed(3));
    });
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setHelp(false);
      setPalette(false);
      setSettings(false);
      closeTray(); // works wherever the focus is
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || (t.classList && t.classList.contains('knob')))) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) engine.seek(dir * 10);
      else (dir < 0 ? prevTrack : nextTrack)();
      return;
    }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      if (state.power && !panel.open) {
        nudgePanel(e.key === ']' ? 2 : -2);
        engine.click('servo', 300, 'nolatch');
        panel.tiltIdx = Math.max(0, PANEL_TILTS.indexOf(Math.round(panel.rest)));
        flash(angleText());
        scheduleSave();
        syncUI();
      }
      return;
    }
    if (e.key === 'C' && e.shiftKey) {
      e.preventDefault();
      if (state.power) cycleTheme(-1); // Shift+C: the previous colour
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      knobs.vol.set(knobs.vol.value + (e.key === 'ArrowUp' ? 0.05 : -0.05)); // volume, like the VOL knob
      return;
    }
    const map = {
      p: 'power', ' ': 'play', m: 'mode', b: 'band', r: 'speed', v: 'fullscreen', k: 'keysound', a: 'agc', f: 'fps', c: 'color', d: 'dim', s: 'sync',
      e: 'eq', x: 'preset', l: 'dsp', n: 'motion', h: 'help', '?': 'help', ',': 'settings', u: 'palette', z: 'theater', i: 'illum', o: 'eject', t: 'tilt', '1': 'src-demo', '2': 'src-mic', '3': 'src-tab', '4': 'src-file',
    };
    const a = map[e.key.toLowerCase()];
    if (!a) return;
    e.preventDefault();
    actions[a]();
  });

  // ---- knobs ---------------------------------------------------------------
  class Knob {
    constructor(el, opts) {
      this.el = el;
      this.value = opts.value;
      this.initial = opts.initial === undefined ? opts.value : opts.initial;
      this.onChange = opts.onChange;
      this.steps = opts.steps || 40;
      this.lastStep = Math.round(this.value * this.steps);
      this.lastTick = 0;
      this.drag = null;
      el.addEventListener('pointerdown', (e) => {
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
        this.drag = { y: e.clientY, v: this.value };
        e.preventDefault();
      });
      el.addEventListener('pointermove', (e) => {
        if (this.drag) this.set(this.drag.v + (this.drag.y - e.clientY) / 160);
      });
      const end = () => (this.drag = null);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.set(this.value - Math.sign(e.deltaY) * 0.03);
      }, { passive: false });
      el.addEventListener('keydown', (e) => {
        const step = { ArrowUp: 0.025, ArrowRight: 0.025, ArrowDown: -0.025, ArrowLeft: -0.025, PageUp: 0.1, PageDown: -0.1 }[e.key];
        if (step === undefined) return;
        e.preventDefault();
        this.set(this.value + step);
      });
      el.addEventListener('dblclick', () => this.set(this.initial));
      this.render();
      this.onChange(this.value, true);
    }

    // `quiet`: move without detent ticks, on-screen display or saving (used by RESET)
    set(v, quiet) {
      v = Math.min(1, Math.max(0, v));
      if (v === this.value) return;
      this.value = v;
      this.render();
      const step = Math.round(v * this.steps);
      if (step !== this.lastStep) {
        this.lastStep = step;
        const now = performance.now();
        if (!quiet && now - this.lastTick > 28) engine.click('tick');
        this.lastTick = now;
      }
      this.onChange(v, !!quiet);
    }

    render() {
      this.el.style.setProperty('--a', -135 + 270 * this.value + 'deg');
    }
  }

  const knobs = {};
  const clamp01 = (v, d) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);

  knobs.vol = new Knob($('#knob-vol'), {
    value: clamp01(prefs.volume, 0.7),
    initial: 0.7,
    onChange(v, silent) {
      engine.setVolume(v);
      const n = Math.round(v * 40);
      $('#knob-vol').setAttribute('aria-valuenow', n);
      if (!silent && isLive()) sendMusicVolume(v);
      if (!silent) {
        if (state.power) {
          state.osd = { label: 'VOL', value: n, max: 40 };
          state.osdUntil = performance.now() + OSD_MS;
        }
        scheduleSave();
      }
    },
  });

  knobs.sens = new Knob($('#knob-sens'), {
    value: clamp01(prefs.sens, 0.5),
    initial: 0.5,
    steps: 24,
    onChange(v, silent) {
      const db = Math.round((v - 0.5) * 24);
      engine.trimDb = (v - 0.5) * 24;
      $('#knob-sens').setAttribute('aria-valuenow', db);
      if (!silent) {
        if (state.power) flash('SENS ' + (db > 0 ? '+' : '') + db + 'DB');
        scheduleSave();
      }
    },
  });

  // ---- status line ---------------------------------------------------------
  function statusText(mode, now) {
    if (!state.power) return now < state.byeUntil ? { left: 'GOOD BYE', right: '', amber: false } : { left: '', right: '', amber: false };
    if (openingTime(now) >= 0) return { left: 'HELLO', right: '', amber: false };

    let left;
    let amber = false;
    let scroll = 0;
    if (now < state.flashUntil) {
      left = state.flashText;
      amber = true;
    } else if (state.source === 'file') {
      const n = state.tracks.length;
      left = 'TRK ' + pad2(state.trackIdx + 1) + (n > 1 ? '/' + pad2(n) : '');
    } else if (state.source === 'mic') left = 'MIC INPUT';
    else if (state.source === 'tab') left = NATIVE ? 'SYSTEM AUDIO' : 'TAB AUDIO';
    else if (state.source === 'demo') left = 'DEMO SYNTH';
    else left = 'NO SOURCE';

    if (state.silentSince && now - state.silentSince > 4000 && now >= state.flashUntil) {
      // a live input that has gone quiet: blink a warning instead of leaving an empty display unexplained
      left = Math.floor(now / 600) % 2 ? 'NO SIGNAL' : '';
      amber = true;
    }

    let time = '';
    if (state.source === 'mic' || state.source === 'tab') {
      const mt = musicTime(now); // the Music app's track time when it is known
      time = mt >= 0 ? pad2(Math.floor(mt / 60) % 100) + ':' + pad2(Math.floor(mt) % 60) : 'LIVE';
    } else if (state.source) {
      const t = Math.floor(engine.getTime());
      time = pad2(Math.floor(t / 60) % 100) + ':' + pad2(t % 60);
    }
    const playMark = isPlaying() ? '>' : 'II';
    const right = mode.kind === 'eq'
      ? 'EQ ' + EQ_PRESETS[state.eqPreset].name
      : engine.bandCount + 'B ' + (engine.agc ? 'AGC' : '---') + ' ' + (state.source ? playMark + ' ' + time : '');
    return { left, right, amber, scroll };
  }

  // The title line: what is playing. Files show their tag title (or file name); live inputs show what the
  // optional helper reports for the Music app; the demo names itself.
  function npTitle() {
    const i = state.np;
    if (!i || !i.running || !i.title || i.state === 'stopped') return '';
    return i.artist ? i.title + '  -  ' + i.artist : i.title;
  }

  function currentTitle() {
    if (state.source === 'file') return state.trackTitle || state.fileName;
    if (state.source === 'mic' || state.source === 'tab') return npTitle();
    if (state.source === 'demo') return 'SAMPLE BEAT  118 BPM  -  VFD-5000';
    return '';
  }

  function clockInfo() {
    const d = new Date();
    return {
      text: pad2(d.getHours()) + (d.getSeconds() % 2 === 0 ? ':' : ' ') + pad2(d.getMinutes()),
      date: DAYS[d.getDay()] + ' ' + pad2(d.getDate()) + ' ' + MONTHS[d.getMonth()],
      sec: d.getSeconds(),
    };
  }

  // ---- main loop: intentionally capped to ~30fps for that microcontroller feel ----
  const levels = new Float32Array(32);
  const wave = new Float32Array(1024);
  const lvl2 = new Float32Array(2);
  const ann = { play: false, pause: false, demo: false, mic: false, tab: false, file: false, st: false, eq: false, agc: false, dim: false, sync: false, rpt: false, mute: false };

  function updateAnn() {
    const on = state.power;
    const playing = on && isPlaying();
    ann.play = playing;
    ann.pause = on && !!state.source && !playing;
    ann.demo = on && state.source === 'demo';
    ann.mic = on && state.source === 'mic';
    ann.tab = on && state.source === 'tab';
    ann.file = on && state.source === 'file';
    ann.st = on && (state.source === 'demo' || state.source === 'file' || state.source === 'tab');
    ann.eq = on && state.eqPreset !== 0;
    ann.agc = on && engine.agc;
    ann.dim = on && state.dim;
    ann.sync = on && state.sync;
    ann.rpt = on && state.source === 'file';
    ann.mute = on && knobs.vol.value < 0.01;
  }

  const ui = { power: false, allOn: false, ann, standby: false, warm: 0, brightness: 1, mode: 'bar', dt: 0, leftText: '', amber: false, rightText: '', eq: state.eqGains, meter, clock: null };
  let nextDue = 0;
  let idleNext = 0;
  let lastRun = 0;
  let lastFrameAt = 0;
  let lastGlow = -1;
  let lastPulse = -1;
  let lastUiSync = 0;
  let lastPanelPower = false;
  let lastBooting = false;
  const disc = { angle: 0, omega: 0 };
  const discEl = $('#disc-window i');

  function tick(now) {
    requestAnimationFrame(tick);
    frame(now);
  }

  function frame(now) {
    // Fixed schedule (not "elapsed since last frame"): frames are due every `interval` ms, with 2ms of slack
    // for vsync jitter. Resyncs instead of bursting after a stall (e.g. a hidden tab).
    if (now < nextDue - 2) return;
    nextDue += 1000 / state.fps;
    if (nextDue < now) nextDue = now + 1000 / state.fps;
    // Powered off and settled (standby clock, faint filament shimmer): 10 fps is plenty, and it cuts the idle
    // cost of the window to a third. Anything that moves (parallax, GOOD BYE, disc, a message) wakes it at once.
    if (!state.power && state.warm === 0 && now >= state.byeUntil && now >= state.flashUntil && openingTime(now) < 0 &&
        disc.omega <= 0.004 && Math.abs(par.x - parTarget.x) < 0.004 && Math.abs(par.y - parTarget.y) < 0.004) {
      if (now < idleNext) return;
      idleNext = now + 100;
    }
    const dt = Math.min((now - lastRun) / 1000, 0.1);
    lastFrameAt = lastRun;
    lastRun = now;

    const mode = effectiveMode(now);
    refreshLayout(mode);

    const n = engine.bandCount;
    const openT = openingTime(now);
    const booting = openT >= 0;
    if (state.power && state.sleepAt) {
      if (now >= state.sleepAt) powerOff(); // the sleep timer ran out
      else if (!state.sleepWarned && state.sleepAt - now < 60000) {
        state.sleepWarned = true;
        flash('SLEEP 1 MIN', 3500);
      }
    }
    if (state.autoPattern && state.power && !booting && now >= state.autoNextAt) {
      state.autoNextAt = now + state.autoPattern * 1000;
      const cur = MODES[state.modeIdx];
      if (cur.kind !== 'clock' && !state.eqEdit && now >= state.osdUntil) {
        let next = state.modeIdx;
        do next = (next + 1) % MODES.length; while (MODES[next].kind === 'clock');
        setMode(next);
      }
    }
    if (booting) {
      openingLevels(openT, n, levels);
      lvl2[0] = lvl2[1] = 0;
      // the display check leaves no peak dots behind while the logo is up
      if (openT >= OPENING.testEnd && openT < OPENING.sweepStart - 0.02) {
        model.bars.fill(0);
        model.peaks.fill(0);
      }
    } else if (state.power) {
      engine.getBandLevels(levels, dt);
      if (state.source === 'mic' || state.source === 'tab') {
        let peak = 0;
        for (let i = 0; i < n; i++) if (levels[i] > peak) peak = levels[i];
        if (peak > 0.05) state.silentSince = 0;
        else if (!state.silentSince) state.silentSince = now;
      } else {
        state.silentSince = 0;
      }
      if (mode.kind === 'level') engine.getStereoLevels(lvl2);
      else lvl2[0] = lvl2[1] = 0;
      if (mode.kind === 'scope') engine.getWave(wave);
    } else {
      levels.fill(0);
      lvl2[0] = lvl2[1] = 0;
    }

    // Start-up self test on the panel itself: the knob scales light fully, then fall back to the knob
    // position, while the key LEDs run a chase (CSS, keyed off the .booting class).
    if (booting !== lastBooting) {
      lastBooting = booting;
      faceplate.classList.toggle('booting', booting);
      if (!booting) Object.values(knobs).forEach((k) => k.el.style.removeProperty('--lit'));
    }
    if (booting) {
      // the dial rings follow the display: strobe with the check, dark, sweep up to full while the logo ignites, hold
      // through the build-up, then fall back to the knob position after the impact
      const O = OPENING;
      const out3 = (u) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
      Object.values(knobs).forEach((k) => {
        let lit;
        if (O.checkOn(openT)) lit = 1;
        else if (openT < O.lineStart + 0.1) lit = -0.02;
        else if (openT < 2.3) lit = out3((openT - (O.lineStart + 0.1)) / (2.3 - (O.lineStart + 0.1)));
        else if (openT < O.flashAt) lit = 1;
        else if (openT < O.flashAt + 0.9) lit = k.value + (1 - k.value) * (1 - out3((openT - O.flashAt) / 0.9));
        else lit = k.value;
        k.el.style.setProperty('--lit', (-135 + 270 * lit).toFixed(1) + 'deg');
      });
    }

    // VFD warm-up: the filament takes a moment to bring the phosphor up (with a stutter); on power-off the
    // phosphor keeps glowing for a beat while it decays, then the unit falls back to its standby clock.
    if (state.power) {
      const since = (now - state.bootStart) / 1000;
      // the heater comes on first; the phosphor follows a moment later
      state.warm = Math.min(1, Math.max(0, (since - 0.12) / 0.4)) * (since < 0.7 ? 0.8 + 0.2 * Math.random() : 1);
      model.update(levels, dt);
      meter.update(lvl2, dt);
    } else if (now < state.byeUntil) {
      model.update(levels, dt); // the bars fall away while GOOD BYE shows
      meter.update(lvl2, dt);
    } else {
      state.warm *= Math.exp(-((now - lastFrameAt) / 1000) / 0.09);
      if (state.warm < 0.01) {
        state.warm = 0;
        model.update(levels, dt);
        meter.update(lvl2, dt);
      }
    }
    const standby = !state.power && state.warm === 0;
    const drive = standby ? STANDBY_DRIVE : state.warm;

    // filament temperature: heats in ~0.4 s, cools slowly (seconds) after power-off; stays warm in standby
    const heatTarget = state.power ? 1 : standby ? 0.55 : Math.max(0.55, state.heat);
    const heatTau = heatTarget > state.heat ? 0.35 : 1.4;
    state.heat += (heatTarget - state.heat) * (1 - Math.exp(-dt / heatTau));

    // display light spill onto the bezel + bass pulse for SYNC (written to CSS only when it visibly changes)
    let activity;
    if (mode.kind === 'bars') {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += model.bars[i];
      activity = sum / n;
    } else if (mode.kind === 'level') activity = ((meter.bars[0] + meter.bars[1]) / 2) * 0.9;
    else if (mode.kind === 'eq') activity = 0.3;
    else if (mode.kind === 'scope') {
      let e2 = 0;
      for (let i = 0; i < 1024; i += 8) e2 += wave[i] * wave[i];
      activity = Math.min(1, Math.sqrt(e2 / 128) * 4); // the bezel glow follows the loudness of the trace
    }
    else activity = 0.14;
    if (booting) activity = Math.max(activity, openingGlow(openT)); // the opening lights the bezel too
    const glowTarget = activity * drive * dimGain();
    state.glow += (glowTarget - state.glow) * 0.35;
    const bass = (model.bars[0] + model.bars[1] + model.bars[2]) / 3;
    state.pulse += (bass * state.warm - state.pulse) * 0.5;
    if (Math.abs(state.glow - lastGlow) > 0.015) {
      lastGlow = state.glow;
      faceplate.style.setProperty('--g', state.glow.toFixed(3));
    }
    if (state.sync && Math.abs(state.pulse - lastPulse) > 0.02) {
      lastPulse = state.pulse;
      faceplate.style.setProperty('--pulse', state.pulse.toFixed(3));
    }

    if (state.power !== lastPanelPower) {
      lastPanelPower = state.power; // ignition on/off: the panel comes out to its angle or tucks away
      if (!panel.open) movePanel(restAngle(), 32);
    }
    const reading = now < state.flashUntil && state.flashText === 'READING';
    const spinTarget = state.power && state.source === 'file' && engine.isPlaying() ? 0.9 : reading ? 2.2 : 0;
    disc.omega += (spinTarget - disc.omega) * (1 - Math.exp(-dt / (spinTarget > disc.omega ? 0.5 : 1.3)));
    if (disc.omega > 0.004) {
      disc.angle = (disc.angle + disc.omega * 360 * dt) % 360;
      discEl.style.setProperty('--spin', disc.angle.toFixed(1) + 'deg');
    }

    if (now - lastUiSync > 400) {
      lastUiSync = now;
      syncUI();
      updateWakeLock();
    }

    const st = statusText(mode, now);
    ui.power = state.power || state.warm > 0.01;
    ui.standby = standby;
    ui.warm = state.warm;
    ui.brightness = dimGain();
    par.x += (parTarget.x - par.x) * 0.12;
    par.y += (parTarget.y - par.y) * 0.12;
    ui.parX = par.x;
    ui.parY = par.y;
    ui.activity = activity;
    ui.heat = state.heat;
    ui.mode = mode.id;
    ui.osd = state.osd;
    ui.wave = mode.kind === 'scope' && state.power && !booting ? wave : null;
    ui.opening = booting;
    ui.openT = openT;
    ui.allOn = booting && OPENING.checkOn(openT);
    updateAnn();
    ui.dt = dt;
    const title = currentTitle();
    if (title !== state.titleKey) {
      state.titleKey = title;
      state.titleStart = now; // a new title starts scrolling from its beginning
      if (NATIVE) window.webkit.messageHandlers.vfd.postMessage({ cmd: 'title', text: state.power ? title : '' }); // shown under the window title
    }
    ui.titleText = state.power ? title : '';
    ui.titleStart = state.titleStart;
    ui.now = now;
    ui.leftText = st.left;
    ui.leftScroll = st.scroll || 0;
    ui.amber = st.amber;
    ui.rightText = st.right;
    ui.clock = mode.kind === 'clock' ? clockInfo() : null;
    renderer.render(model, ui);
  }

  // ---- init ----------------------------------------------------------------
  new ResizeObserver((entries) => {
    renderer.resize(entries[0].contentRect.width, window.devicePixelRatio || 1);
  }).observe(canvas);

  applySpeed();
  ['agc', 'fps', 'dim', 'sync', 'eq', 'dsp', 'motion', 'illum', 'src-demo', 'src-mic', 'src-tab', 'src-file', 'play'].forEach((a) => {
    const el = document.querySelector('[data-action="' + a + '"]');
    if (el) el.classList.add('latch');
  });
  document.querySelectorAll('.btn').forEach((b, i) => b.style.setProperty('--i', i)); // order of the start-up LED chase
  if (NATIVE) {
    const sys = document.querySelector('[data-action="src-tab"]');
    sys.querySelector('span').textContent = 'SYS';
    sys.title = 'Capture the Mac\'s system audio (Apple Music, browsers, ...)';
  }
  setPanelAngle(PANEL_RETRACT);
  pollNowPlaying();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollNowPlaying(); // refresh straight away when the tab comes back
  });
  state.eqGains.set(state.eqPreset === USER_PRESET ? state.eqUser : EQ_PRESETS[state.eqPreset].gains);
  engine.setEq(state.eqGains);
  document.body.classList.toggle('theater', state.theater);
  applyTheme();
  buildPalette();
  refreshPalette();
  applyDim();
  requestAnimationFrame(tick);
  // The Mac app behaves like a head unit on ignition: it comes up with the opening, unless it was switched off last time.
  if (NATIVE && state.autoStart) setTimeout(() => { if (!state.power) powerOn(state.lastSource || undefined); }, 900);
  if (NATIVE && !window.VFD_PREFS) scheduleSave(); // first run with the app's own settings file: copy the browser-side settings into it

  // Hosted (https) copies work offline once loaded: a service worker keeps the app files. It is not used in the Mac app or
  // by the local development servers (?sw=1 turns it on there for testing).
  if ('serviceWorker' in navigator && !NATIVE && (location.protocol === 'https:' || /[?&]sw=1\b/.test(location.search))) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* not available: the app simply needs the network */ });
  }

  window.vfdApp = { prefsJSON: () => JSON.stringify(prefsObject()), engine, model, meter, renderer, state, frame, actions, ui, openSettings: () => setSettings(true), settings: () => settingsUI, transport: { control, isPlaying, musicTime }, holdOpening: (t) => { state.openHold = t; }, skipOpening, panel: { state: panel, update: panelUpdate, move: movePanel, setAngle: setPanelAngle, open: openTray, close: closeTray } };
})();
