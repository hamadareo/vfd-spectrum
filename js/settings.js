(function (global) {
  'use strict';
  const VFD = (global.VFD = global.VFD || {});

  // The settings screen. Everything the panel's keys do, in plain words: choices are buttons, on/off settings are
  // switches, numbers are sliders, and each row says in one sentence what it changes. It is built from a description
  // (TABS below) and talks to the app only through the `api` object that main.js hands over, so the screen and the
  // keys can never disagree: `refresh()` re-reads the app's state, and every control writes through the same setters
  // the keys use.

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---- controls: each returns { node, update(value) } ---------------------------------------------------
  function choiceControl(options, onPick, columns) {
    const node = el('div', 'set-choice');
    if (columns) node.style.setProperty('--cols', columns);
    node.setAttribute('role', 'radiogroup');
    const buttons = options.map((o) => {
      const b = el('button', 'set-pill', o.label);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', (e) => {
        onPick(o.value);
        if (e.detail > 0) b.blur();
      });
      node.appendChild(b);
      return b;
    });
    return {
      node,
      update(value) {
        buttons.forEach((b, i) => {
          const on = options[i].value === value;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
        });
      },
    };
  }

  function switchControl(onChange, label) {
    const node = el('button', 'set-switch');
    node.type = 'button';
    node.setAttribute('role', 'switch');
    node.setAttribute('aria-label', label);
    node.innerHTML = '<i></i>';
    let value = false;
    node.addEventListener('click', (e) => {
      onChange(!value);
      if (e.detail > 0) node.blur();
    });
    return {
      node,
      update(v) {
        value = !!v;
        node.classList.toggle('on', value);
        node.setAttribute('aria-checked', String(value));
      },
    };
  }

  function sliderControl(spec) {
    const node = el('div', 'set-slider');
    const input = el('input');
    input.type = 'range';
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step || 1;
    input.setAttribute('aria-label', spec.label);
    const value = el('output', 'set-value');
    const ends = el('div', 'set-ends');
    ends.append(el('span', '', spec.lo || ''), el('span', '', spec.hi || ''));
    node.append(input, value, ends);
    input.addEventListener('input', () => {
      value.textContent = spec.format(+input.value);
      spec.onInput(+input.value);
    });
    return {
      node,
      update(v) {
        if (document.activeElement !== input) input.value = v; // never fight a slider that is being dragged
        value.textContent = spec.format(+v);
      },
    };
  }

  // ready-made looks: a grid of cards, each with a swatch of its colours
  function looksControl(getLooks, onPick) {
    const node = el('div', 'set-looks');
    node.setAttribute('role', 'radiogroup');
    let buttons = null;
    let looks = null;
    const build = () => {
      looks = getLooks();
      buttons = looks.map((L) => {
        const b = el('button', 'set-look');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        const sw = el('i', 'set-look-swatch');
        sw.style.background = L.gradient;
        b.append(sw, el('b', '', L.name), el('span', '', L.note));
        b.addEventListener('click', (e) => {
          onPick(L.id);
          if (e.detail > 0) b.blur();
        });
        node.appendChild(b);
        return b;
      });
    };
    return {
      node,
      update(value) {
        if (!buttons) build(); // (built on first use: the colour table is ready by then)
        buttons.forEach((b, i) => {
          const on = looks[i].id === value;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
        });
      },
    };
  }

  function buttonsControl(list) {
    const node = el('div', 'set-actions');
    const buttons = list.map((b) => {
      const x = el('button', 'set-button' + (b.kind ? ' ' + b.kind : ''), b.label);
      x.type = 'button';
      x.addEventListener('click', (e) => {
        b.onClick(x);
        if (e.detail > 0 && !b.keepFocus) x.blur();
      });
      node.appendChild(x);
      return x;
    });
    return { node, update() {}, buttons };
  }

  // ---- the screen ---------------------------------------------------------------------------------------
  function createSettings(api, root) {
    const s0 = () => api.get();

    const MODE_JA = { bar: '標準', peak: 'ピークのみ', mirror: 'ミラー', center: '中央から', level: 'レベル', fan: '遠近', scope: '波形', clock: '時計' };
    const EQ_JA = ['フラット', 'ロック', 'ポップ', 'ジャズ', '低音強調', 'ボーカル', 'ユーザー'];
    const SOURCE_DESC = {
      demo: 'アプリに内蔵されたデモ音を表示します。',
      mic: 'マイクで拾った音を表示します。パソコンの近くで鳴っている音楽などに使えます。',
      tab: api.native
        ? 'この Mac で再生中の音（Apple Music など）をそのまま表示します。Mac の設定で「システム音声の録音」を許可してください。'
        : '別のブラウザタブで再生中の音を表示します（Chrome / Edge）。',
      file: '音声ファイルを選んで再生します。複数選ぶと順番に再生します。',
      none: 'まだ入力が選ばれていません。下から選んでください。',
    };

    // What to do when an input does not work (main.js sets `problem`); `pane` is the System Settings page to open.
    const PROBLEM = {
      'sys-denied': {
        pane: 'audio',
        mac: 'システム音声の録音が許可されていません。「システム設定 → プライバシーとセキュリティ → 画面収録とシステムオーディオ録音」を開き、「システムオーディオ録音のみ」の VFD Spectrum をオンにしてから、もう一度「システム音声」を押してください。',
        web: '',
      },
      'sys-error': {
        pane: 'audio',
        mac: 'システム音声をうまく取り込めませんでした。もう一度「システム音声」を押してください。直らないときは、下のボタンで許可の状態を確かめて、アプリを開き直してください。',
        web: '',
      },
      'sys-old': {
        pane: 'audio',
        mac: 'この Mac の macOS ではシステム音声を取り込めません（macOS 14.2 以降が必要です）。代わりに「マイク」か「ファイル」を使えます。',
        web: '',
      },
      mic: {
        pane: 'mic',
        mac: 'マイクが使えません。「システム設定 → プライバシーとセキュリティ → マイク」を開いて、VFD Spectrum をオンにしてから、もう一度「マイク」を押してください。',
        web: 'マイクが使えません。ブラウザのアドレスバーの近くにあるマイクの許可を確認して、もう一度「マイク」を押してください。',
      },
      tab: {
        pane: '',
        mac: '',
        web: '他のタブの音を取り込めませんでした。もう一度「他のタブ」を押し、音を出しているタブを選んで「タブの音声も共有」にチェックを入れてください。',
      },
      'tab-unsupported': {
        pane: '',
        mac: '',
        web: 'この端末やブラウザでは「他のタブ」の機能が使えません（iPad の Safari など）。代わりに「マイク」か「ファイル」をお使いください。',
      },
      music: {
        pane: 'automation',
        mac: 'Music アプリの曲名と操作を使うには許可が必要です。「システム設定 → プライバシーとセキュリティ → オートメーション」を開き、VFD Spectrum の下の「ミュージック」をオンにしてください。',
        web: '曲名を取得できませんでした。Music アプリの操作の許可が必要です。',
      },
    };

    // Each row: title, desc (string or function of state), control, get(state) -> value for the control, only(state).
    const TABS = [
      {
        id: 'display',
        label: '表示',
        rows: [
          {
            title: 'おすすめスタイル',
            desc: '色・表示パターン・動きをまとめて切り替えます。選んだあとで、下の項目を個別に変えられます。',
            control: () => looksControl(() => api.looks(), (id) => api.applyLook(id)),
            get: (s) => s.look,
          },
          {
            title: '表示パターン',
            desc: '音の見せ方を選びます。画面をクリックしても切り替わります。',
            control: () => choiceControl(api.modes.map((m, i) => ({ value: i, label: MODE_JA[m] || m })), (v) => api.setMode(v), 4),
            get: (s) => s.mode,
          },
          {
            title: 'パターンの自動切り替え',
            desc: (s) => (s.autoPattern ? s.autoPattern + ' 秒ごとに、表示パターンが順番に変わります（時計は除く）。' : '一定の時間ごとに、表示パターンを自動で切り替えます。ディスプレイを眺めるときに。'),
            control: () => choiceControl([{ value: 0, label: 'しない' }, { value: 15, label: '15 秒' }, { value: 30, label: '30 秒' }, { value: 60, label: '1 分' }], (v) => api.setAutoPattern(v), 4),
            get: (s) => s.autoPattern,
          },
          {
            title: 'バーの本数',
            desc: '棒の数です。少ないほど太く、大きく見えます。',
            control: () => choiceControl([{ value: 9, label: '9 本' }, { value: 13, label: '13 本' }, { value: 15, label: '15 本' }], (v) => api.setBands(v), 3),
            get: (s) => s.bands,
          },
          {
            title: '動きの大きさ',
            desc: '音に合わせてバーがどれだけ大きく動くかです。「最大」はとても激しく動きます。',
            control: () => choiceControl([{ value: 0, label: 'ふつう' }, { value: 1, label: '大きい' }, { value: 2, label: '最大' }], (v) => api.setMotion(v), 3),
            get: (s) => s.motion,
          },
          {
            title: 'バーの下がる速さ',
            desc: '音が止まったあと、バーが下がっていく速さです。',
            control: () => choiceControl([{ value: 2, label: 'ゆっくり' }, { value: 0, label: 'ふつう' }, { value: 1, label: 'はやい' }], (v) => api.setSpeed(v), 3),
            get: (s) => s.speed,
          },
          {
            title: '明るさ',
            desc: '暗い部屋では下げると目に優しくなります。',
            control: () => sliderControl({ label: '明るさ', min: 1, max: 13, lo: '暗い', hi: '明るい', format: (v) => (v >= 13 ? '最大' : v + ' / 13'), onInput: (v) => api.setBrightness(v) }),
            get: (s) => s.brightness,
          },
          {
            title: '表示の色',
            desc: (s) => '現在の色：' + s.themeName + '。たくさんの色や、自由に作れる色があります。',
            control: () => buttonsControl([{ label: 'カラーを選ぶ', kind: 'primary', keepFocus: true, onClick: () => api.openPalette() }]),
          },
          {
            title: '感度を自動で調整',
            desc: '音が小さくても大きくても、バーが見やすく動くように自動で合わせます。',
            control: () => switchControl((v) => api.setAgc(v), '感度を自動で調整'),
            get: (s) => s.agc,
          },
          {
            title: '感度（手動）',
            desc: 'バーの反応の強さを手動で調整します。自動調整をオフにしたときにも使えます。',
            control: () => sliderControl({ label: '感度', min: -12, max: 12, lo: '弱い', hi: '強い', format: (v) => (v > 0 ? '+' : '') + v + ' dB', onInput: (v) => api.setSens(v) }),
            get: (s) => s.sens,
          },
          {
            title: '音に合わせてパネルを光らせる',
            desc: '低音に合わせて、キーの照明が明るくなったり暗くなったりします。',
            control: () => switchControl((v) => api.setSync(v), '音に合わせてパネルを光らせる'),
            get: (s) => s.sync,
          },
          {
            title: '表示のなめらかさ',
            desc: '「なめらか」は動きが滑らかですが、パソコンへの負担が少し増えます。',
            control: () => choiceControl([{ value: 30, label: '標準（30）' }, { value: 60, label: 'なめらか（60）' }], (v) => api.setFps(v), 2),
            get: (s) => s.fps,
          },
          {
            title: 'ディスプレイだけを大きく表示',
            desc: 'つまみやキーを隠して、表示部をウィンドウいっぱいに広げます。',
            control: () => switchControl((v) => api.setTheater(v), 'ディスプレイだけを大きく表示'),
            get: (s) => s.theater,
          },
        ],
      },
      {
        id: 'sound',
        label: 'サウンド',
        rows: [
          {
            title: '音量',
            desc: (s) => (s.live ? 'いまは Music アプリの音量を操作します。' : 'このアプリで再生する音の大きさです。'),
            control: () => sliderControl({ label: '音量', min: 0, max: 100, lo: '小さい', hi: '大きい', format: (v) => v + ' %', onInput: (v) => api.setVolume(v / 100) }),
            get: (s) => Math.round(s.volume * 100),
          },
          {
            title: '音質（イコライザー）',
            desc: '音質の傾向を選びます。表示にも反映されます。',
            control: () => choiceControl(EQ_JA.map((n, i) => ({ value: i, label: n })), (v) => api.setPreset(v), 4),
            get: (s) => s.eqPreset,
          },
          {
            title: '細かい音質調整',
            desc: 'ディスプレイ上で、15 の帯域をドラッグして自由に調整します。もう一度押すと終了します。',
            control: () => buttonsControl([{ label: '調整画面を開く / 閉じる', keepFocus: true, onClick: () => api.toggleEqEdit() }]),
          },
          {
            title: '響き（リバーブ）',
            desc: '音に響きを加えます。ファイルとデモの再生で聞こえます（Music の音や、マイクの音には効きません）。',
            control: () => choiceControl([{ value: 0, label: 'なし' }, { value: 1, label: 'ホール' }, { value: 2, label: 'ライブ' }, { value: 3, label: 'クラブ' }], (v) => api.setDsp(v), 4),
            get: (s) => s.dsp,
          },
          {
            title: 'ボタンの操作音',
            desc: 'キーやつまみを操作したときの「カチッ」という音です。',
            control: () => switchControl((v) => api.setKeySound(v), 'ボタンの操作音'),
            get: (s) => s.keySound,
          },
          {
            title: '起動時のオープニング',
            desc: '電源を入れたときの映像と音の演出です。光が強く点滅する場面があるので、まぶしさや点滅が苦手な方はオフにしてください。OS の「視差効果を減らす」がオンのときは、自動で省かれます。',
            control: () => switchControl((v) => api.setOpening(v), '起動時のオープニング'),
            get: (s) => s.opening,
          },
        ],
      },
      {
        id: 'source',
        label: '入力・再生',
        rows: [
          {
            title: '何の音を表示するか',
            desc: (s) => SOURCE_DESC[s.source || 'none'],
            control: () =>
              choiceControl(
                [
                  { value: 'demo', label: 'デモ' },
                  { value: 'mic', label: 'マイク' },
                  // other tabs / system audio can only be captured where the browser offers it (not on an iPad)
                  ...(api.native || api.canTabCapture ? [{ value: 'tab', label: api.native ? 'システム音声' : '他のタブ' }] : []),
                  { value: 'file', label: 'ファイル' },
                ],
                (v) => api.selectSource(v),
                api.native || api.canTabCapture ? 4 : 3
              ),
            get: (s) => s.source,
          },
          {
            title: '困ったときは',
            desc: (s) => (PROBLEM[s.problem] ? (api.native ? PROBLEM[s.problem].mac : PROBLEM[s.problem].web) : ''),
            control: () => (api.native ? buttonsControl([{ label: 'システム設定を開く', kind: 'primary', keepFocus: true, onClick: () => api.openPrivacy(PROBLEM[api.get().problem] && PROBLEM[api.get().problem].pane) }]) : null),
            only: (s) => !!PROBLEM[s.problem],
            notice: true,
          },
          {
            title: '再生の操作',
            desc: (s) => (s.live ? 'Music アプリを操作します。' : s.source === 'file' ? 'ファイルの再生を操作します。' : 'ファイルを再生しているときに使えます。'),
            control: () =>
              buttonsControl([
                { label: '◀◀ 前の曲', onClick: () => api.transport('prev') },
                { label: '再生 / 一時停止', kind: 'primary', onClick: () => api.transport('play') },
                { label: '次の曲 ▶▶', onClick: () => api.transport('next') },
              ]),
          },
          {
            title: '曲名の表示',
            desc: 'ファイルの曲名は自動で読み取ります。Apple Music の曲名は、Mac アプリ版で「システム音声」か「マイク」を選ぶと表示されます。',
            info: true,
          },
        ],
      },
      {
        id: 'panel',
        label: 'パネル',
        rows: [
          {
            title: 'パネルの角度',
            desc: '本体の傾きを変えます。見やすい角度に合わせてください。',
            control: () => sliderControl({ label: 'パネルの角度', min: -8, max: 22, lo: '前に傾ける', hi: '後ろに傾ける', format: (v) => (v > 0 ? '+' : '') + v + '°', onInput: (v) => api.setAngle(v, false) }),
            get: (s) => Math.round(s.angle),
          },
          {
            title: '角度のおすすめ',
            desc: 'ワンタッチで切り替えます。',
            control: () =>
              buttonsControl([
                { label: 'まっすぐ', onClick: () => api.setAngle(0, true) },
                { label: '少し後ろへ', onClick: () => api.setAngle(8, true) },
                { label: '少し前へ', onClick: () => api.setAngle(-5, true) },
              ]),
          },
          {
            title: 'キーの照明の色',
            desc: (s) => '現在の色：' + s.illumName + '。「自動」のときは表示の色に合わせます。',
            control: () => buttonsControl([{ label: 'カラーを選ぶ', kind: 'primary', keepFocus: true, onClick: () => api.openPalette() }]),
          },
          {
            title: '常に手前に表示',
            desc: '他のウィンドウの上に表示し続けます。',
            control: () => switchControl((v) => api.setKeepOnTop(v), '常に手前に表示'),
            get: (s) => s.keepOnTop,
            only: () => api.native,
          },
        ],
      },
      {
        id: 'more',
        label: 'そのほか',
        rows: [
          {
            title: 'スリープタイマー',
            desc: (s) => (!s.power ? '電源が入っているときに設定できます。' : s.sleepMin ? 'あと約 ' + Math.max(1, Math.ceil(s.sleepLeft)) + ' 分で、自動的に電源が切れます。' : '決めた時間がたつと、自動で電源を切ります。寝る前の音楽などに。'),
            control: () => choiceControl([{ value: 0, label: '切' }, { value: 15, label: '15 分' }, { value: 30, label: '30 分' }, { value: 60, label: '60 分' }, { value: 90, label: '90 分' }], (v) => api.setSleep(v), 5),
            get: (s) => s.sleepMin,
          },
          {
            title: '画面を点けたままにする',
            desc: '電源が入っている間、画面が暗くなったり消えたりしないようにします。タブレットを車内などに置いて使うときに便利です。',
            control: () => switchControl((v) => api.setKeepAwake(v), '画面を点けたままにする'),
            get: (s) => s.keepAwake,
            only: (s) => s.wakeLockSupported,
          },
          {
            title: '起動と同時に電源を入れる',
            desc: 'アプリを開いたらすぐにオープニングを流して、使い始められます。',
            control: () => switchControl((v) => api.setAutoStart(v), '起動と同時に電源を入れる'),
            get: (s) => s.autoStart,
            only: () => api.native,
          },
          {
            title: '操作説明',
            desc: 'キーボードのショートカットなど、使い方の一覧を表示します。',
            control: () => buttonsControl([{ label: '操作説明を開く', keepFocus: true, onClick: () => api.openHelp() }]),
          },
          {
            title: 'すべての設定を初期化',
            desc: '色・表示・音などの設定をすべて出荷時に戻して、本体を再起動します。',
            control: () => {
              const c = buttonsControl([{ label: '初期化する…', kind: 'danger', keepFocus: true, onClick: () => {} }]);
              const b = c.buttons[0];
              let armed = null;
              const disarm = () => {
                clearTimeout(armed);
                armed = null;
                b.textContent = '初期化する…';
                b.classList.remove('armed');
              };
              b.onclick = null;
              b.addEventListener('click', () => {
                if (armed) {
                  disarm();
                  api.reset();
                } else {
                  b.textContent = '本当に初期化する（もう一度押す）';
                  b.classList.add('armed');
                  armed = setTimeout(disarm, 4000);
                }
              });
              return c;
            },
          },
          {
            title: '設定の保存',
            desc: 'すべての設定は自動で保存されます。アプリを終了しても、次に開いたときにそのまま使えます（Mac アプリでは、専用のファイルにも保存します）。',
            info: true,
          },
          {
            title: 'このアプリについて',
            desc: 'VFD Spectrum — 90〜2000 年代のカーオーディオを思わせる、独自デザインのスペクトラムアナライザーです。特定のメーカーや製品とは関係がありません。文中の会社名・製品名・サービス名は、各社の商標または登録商標です。運転中に画面を見続けるのは危険です。車内で使うときは、安全な場所に停車してからご利用ください。',
            info: true,
          },
          {
            title: 'プライバシー',
            desc: '音声・曲の情報・設定は、この端末の中だけで使われます。このアプリは、それらをインターネットへ送信しません。',
            info: true,
          },
        ],
      },
    ];

    // ---- build the DOM once --------------------------------------------------------------------------------
    root.innerHTML = '';
    const header = el('header', 'settings-head');
    header.append(el('h2', '', '設定'));
    const close = el('button', 'settings-close', '×');
    close.type = 'button';
    close.id = 'settings-close';
    close.setAttribute('aria-label', '設定を閉じる');
    header.appendChild(close);
    const nav = el('nav', 'settings-tabs');
    nav.setAttribute('role', 'tablist');
    const body = el('div', 'settings-body');
    root.append(header, nav, body);

    const rows = []; // { row, control, get, descFn, descEl }
    const panels = {};
    const tabButtons = {};
    TABS.forEach((t) => {
      const tb = el('button', 'settings-tab', t.label);
      tb.type = 'button';
      tb.setAttribute('role', 'tab');
      tb.addEventListener('click', (e) => {
        show(t.id);
        if (e.detail > 0) tb.blur();
      });
      nav.appendChild(tb);
      tabButtons[t.id] = tb;
      const panel = el('div', 'settings-panel');
      panel.setAttribute('role', 'tabpanel');
      t.rows.forEach((r) => {
        const row = el('section', 'set-row' + (r.notice ? ' notice' : ''));
        const head = el('div', 'set-head');
        head.appendChild(el('h3', 'set-title', r.title));
        const desc = el('p', 'set-desc', typeof r.desc === 'string' ? r.desc : '');
        const ctl = r.control ? r.control() : null;
        const inline = ctl && ctl.node.classList.contains('set-switch');
        if (inline) head.appendChild(ctl.node);
        row.append(head, desc);
        if (ctl && !inline) row.appendChild(ctl.node);
        panel.appendChild(row);
        rows.push({ spec: r, row, ctl, desc });
      });
      body.appendChild(panel);
      panels[t.id] = panel;
    });

    let current = TABS[0].id;
    function show(id) {
      current = id;
      TABS.forEach((t) => {
        const on = t.id === id;
        panels[t.id].hidden = !on;
        tabButtons[t.id].classList.toggle('on', on);
        tabButtons[t.id].setAttribute('aria-selected', String(on));
      });
      body.scrollTop = 0;
    }
    show(current);

    function refresh() {
      const s = s0();
      rows.forEach(({ spec, row, ctl, desc }) => {
        if (spec.only) row.hidden = !spec.only(s);
        if (typeof spec.desc === 'function') {
          const text = spec.desc(s);
          if (desc.textContent !== text) desc.textContent = text;
        }
        if (ctl && spec.get) ctl.update(spec.get(s));
      });
    }
    // (the first refresh happens when the screen is opened, once the app's state is fully set up)
    return { refresh, show, closeButton: close };
  }

  VFD.createSettings = createSettings;
})(window);
