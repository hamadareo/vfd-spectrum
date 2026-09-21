import AppKit
import WebKit
import UniformTypeIdentifiers

// WKUserContentController keeps a strong reference to its handlers; this breaks the cycle.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let selfTestDir: String?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: LocalServer?
    private let nowPlaying = NowPlaying()
    private var tap: SystemAudioTap?
    private var jsInFlight = 0
    private var testStarted = false

    private static let preferredPort: UInt16 = 8777
    private var keepOnTop = UserDefaults.standard.bool(forKey: "keepOnTop")
    private var keepOnTopItem: NSMenuItem?

    // Runs before the page's own scripts: tells the web app it is inside the Mac app and forwards errors to the host.
    private static func bootScript(keepOnTop: Bool, prefs: String?) -> String { """
    window.VFD_NATIVE = { platform: 'macos', keepOnTop: \(keepOnTop) };
    window.VFD_PREFS = \(prefs ?? "null");
    window.vfdNative = window.vfdNative || {};
    (function () {
      const post = (m) => { try { window.webkit.messageHandlers.vfd.postMessage(m); } catch (e) {} };
      const err = console.error;
      console.error = function () { post({ cmd: 'log', msg: Array.from(arguments).map(String).join(' ') }); err.apply(console, arguments); };
      window.addEventListener('error', (e) => post({ cmd: 'log', msg: 'uncaught: ' + e.message + ' @' + e.filename + ':' + e.lineno }));
      window.addEventListener('unhandledrejection', (e) => post({ cmd: 'log', msg: 'rejection: ' + ((e.reason && e.reason.message) || e.reason) }));
    })();
    """ }

    init(selfTestDir: String?) {
        self.selfTestDir = selfTestDir
        super.init()
    }

    // ---- launch ----------------------------------------------------------------------------

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root: URL
        if let env = ProcessInfo.processInfo.environment["VFD_WEB_ROOT"] {
            root = URL(fileURLWithPath: env)
        } else if let res = Bundle.main.resourceURL?.appendingPathComponent("web"), FileManager.default.fileExists(atPath: res.path) {
            root = res
        } else {
            fail("The web resources are missing from the app bundle.")
            return
        }
        let srv = LocalServer(root: root, nowPlaying: nowPlaying)
        guard let port = srv.start(preferredPort: AppDelegate.preferredPort) else {
            fail("Could not open a local port for the display.")
            return
        }
        server = srv
        buildMenu()
        buildWindow(port: port)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func fail(_ message: String) {
        if selfTestDir != nil {
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(2)
        }
        let alert = NSAlert()
        alert.messageText = "VFD Spectrum can't start"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // ---- settings that survive quitting ---------------------------------------------------------
    // The page's settings are also kept in a file of their own (~/Library/Application Support/VFD Spectrum/prefs.json),
    // handed to the page at document start. That does not depend on WebKit's storage, which is flushed lazily, is
    // tied to the local port the page happens to be served from, and can be cleared. Self-tests never touch the real
    // file: they only use one when VFD_PREFS_FILE names it.

    private static let prefsEnabled = ProcessInfo.processInfo.arguments.contains("--selftest") == false || ProcessInfo.processInfo.environment["VFD_PREFS_FILE"] != nil
    private static let prefsURL: URL = {
        if let path = ProcessInfo.processInfo.environment["VFD_PREFS_FILE"] { return URL(fileURLWithPath: path) }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSHomeDirectory())
        return base.appendingPathComponent("VFD Spectrum", isDirectory: true).appendingPathComponent("prefs.json")
    }()

    /// The saved settings as a compact JSON object, or nil when there are none (or the file is not a JSON object).
    private static func loadPrefsJSON() -> String? {
        guard prefsEnabled, let data = try? Data(contentsOf: prefsURL), data.count < 1_000_000,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let clean = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: clean, encoding: .utf8) else { return nil }
        return text
    }

    private func savePrefs(_ json: String) {
        guard AppDelegate.prefsEnabled, json.utf8.count < 1_000_000, let data = json.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) != nil else { return }
        let url = AppDelegate.prefsURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    private func clearPrefs() {
        guard AppDelegate.prefsEnabled else { return }
        try? FileManager.default.removeItem(at: AppDelegate.prefsURL)
    }

    private var terminateReplied = false

    /// Quitting asks the page for its settings once more, so a change made a moment before ⌘Q is never lost.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard AppDelegate.prefsEnabled, let wv = webView else { return .terminateNow }
        let finish = { [weak self] in
            guard let self = self, !self.terminateReplied else { return }
            self.terminateReplied = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        wv.evaluateJavaScript("window.vfdApp && window.vfdApp.prefsJSON ? window.vfdApp.prefsJSON() : null") { [weak self] result, _ in
            if let text = result as? String { self?.savePrefs(text) }
            finish()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { finish() } // never hang the quit
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopSystemAudio()
        server?.stop()
    }

    private func buildWindow(port: UInt16) {
        let conf = WKWebViewConfiguration()
        conf.mediaTypesRequiringUserActionForPlayback = [] // the unit powers up with its own key press anyway
        if selfTestDir != nil && ProcessInfo.processInfo.environment["VFD_PERSIST"] == nil {
            conf.websiteDataStore = .nonPersistent() // test runs must not touch the saved settings of the real app
        }
        conf.preferences.isElementFullscreenEnabled = true
        conf.userContentController.addUserScript(WKUserScript(source: AppDelegate.bootScript(keepOnTop: keepOnTop && selfTestDir == nil, prefs: AppDelegate.loadPrefsJSON()), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        conf.userContentController.add(WeakScriptHandler(self), name: "vfd")

        let wv = WKWebView(frame: .zero, configuration: conf)
        wv.uiDelegate = self
        wv.navigationDelegate = self
        wv.underPageBackgroundColor = .black
        wv.isInspectable = true
        webView = wv

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 840),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.title = "VFD Spectrum"
        win.titlebarAppearsTransparent = true
        win.appearance = NSAppearance(named: .darkAqua)
        win.backgroundColor = .black
        win.contentMinSize = NSSize(width: 760, height: 560)
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.contentView = wv
        if selfTestDir == nil && keepOnTop { win.level = .floating }
        if selfTestDir == nil {
            if !win.setFrameUsingName("VFDSpectrumMain") { win.center() }
            win.setFrameAutosaveName("VFDSpectrumMain")
        } else {
            win.center()
        }
        window = win
        win.makeKeyAndOrderFront(nil)
        win.makeFirstResponder(wv)
        wv.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }

    // ---- menu ------------------------------------------------------------------------------

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let app = NSMenu()
        appItem.submenu = app
        app.addItem(withTitle: "About VFD Spectrum", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide VFD Spectrum", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit VFD Spectrum", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        viewItem.submenu = view
        let full = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        view.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        windowItem.submenu = win
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(.separator())
        let float = win.addItem(withTitle: "Keep on Top", action: #selector(toggleKeepOnTop(_:)), keyEquivalent: "t")
        float.keyEquivalentModifierMask = [.command, .option]
        float.state = keepOnTop ? .on : .off
        keepOnTopItem = float

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    @objc private func reloadPage() { webView.reload() }

    // Keep on Top: from the menu (the page is told) or from the page's settings screen (the menu is updated)
    @objc private func toggleKeepOnTop(_ sender: NSMenuItem) {
        setKeepOnTop(!keepOnTop, fromPage: false)
    }

    private func setKeepOnTop(_ on: Bool, fromPage: Bool) {
        keepOnTop = on
        UserDefaults.standard.set(on, forKey: "keepOnTop")
        window.level = on ? .floating : .normal
        keepOnTopItem?.state = on ? .on : .off
        if !fromPage { webView.evaluateJavaScript("window.vfdNative&&window.vfdNative.keepOnTop&&window.vfdNative.keepOnTop(\(on))", completionHandler: nil) }
    }

    @objc private func openSettings() {
        webView.evaluateJavaScript("window.vfdApp&&window.vfdApp.openSettings&&window.vfdApp.openSettings()", completionHandler: nil)
    }

    // ---- web view --------------------------------------------------------------------------

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url {
            if url.scheme == "about" || url.host == "127.0.0.1" || url.host == "localhost" {
                decisionHandler(.allow)
                return
            }
            NSWorkspace.shared.open(url) // anything else opens in the default browser
        }
        decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let dir = selfTestDir, !testStarted {
            testStarted = true
            runSelfTest(dir)
        }
    }

    // microphone: the page asks with getUserMedia; macOS still shows its own permission prompt first
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .deny)
    }

    // the OPEN key / file input
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.audio, .mpeg4Movie]
        panel.message = "Choose audio files"
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // ---- messages from the page ------------------------------------------------------------

    /// The settings screen offers "open System Settings" when a permission is missing. Only these three panes can be
    /// opened, chosen by name; nothing from the page is used to build the URL.
    private func openPrivacyPane(_ pane: String) {
        let anchors = ["audio": "Privacy_AudioCapture", "mic": "Privacy_Microphone", "automation": "Privacy_Automation"]
        guard let anchor = anchors[pane], let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return }
        if selfTestDir != nil { print("[native] would open \(url.absoluteString)"); return } // never pop System Settings open in tests
        NSWorkspace.shared.open(url)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "sysStart": startSystemAudio()
        case "sysStop": stopSystemAudio()
        case "keepOnTop": setKeepOnTop(body["value"] as? Bool ?? false, fromPage: true)
        case "title": window.subtitle = String((body["text"] as? String ?? "").prefix(120))
        case "openPrivacy": openPrivacyPane(body["pane"] as? String ?? "")
        case "savePrefs": if let json = body["json"] as? String { savePrefs(json) }
        case "clearPrefs": clearPrefs()
        case "log":
            let text = "[page] \(body["msg"] as? String ?? "")"
            if selfTestDir != nil { print(text) } else { NSLog("%@", text) }
        default: break
        }
    }

    // ---- system audio ----------------------------------------------------------------------

    private func startSystemAudio() {
        stopSystemAudio()
        let t = SystemAudioTap()
        t.onChunk = { [weak self] data in self?.forwardAudio(data) }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let rate = try t.start()
                DispatchQueue.main.async {
                    guard let self = self else {
                        t.stop()
                        return
                    }
                    self.tap = t
                    self.sysStatus("ok", "{rate: \(Int(rate))}")
                }
            } catch {
                DispatchQueue.main.async {
                    NSLog("system audio: %@", "\(error)")
                    self?.sysStatus("error", "{message: 'capture failed'}")
                }
            }
        }
    }

    private func stopSystemAudio() {
        tap?.stop()
        tap = nil
    }

    // audio queue -> page: base64 float32 stereo chunks; if the page falls behind, chunks are dropped, not queued
    private func forwardAudio(_ data: Data) {
        let b64 = data.base64EncodedString()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.tap != nil, self.jsInFlight < 6 else { return }
            self.jsInFlight += 1
            self.webView.evaluateJavaScript("window.vfdNative&&window.vfdNative.audio&&window.vfdNative.audio('\(b64)')") { [weak self] _, _ in
                self?.jsInFlight -= 1
            }
        }
    }

    private func sysStatus(_ state: String, _ detail: String) {
        webView.evaluateJavaScript("window.vfdNative&&window.vfdNative.status&&window.vfdNative.status('\(state)', \(detail))", completionHandler: nil)
    }

    // ---- self test -------------------------------------------------------------------------

    private func evaluate(_ body: String, _ done: @escaping (Any) -> Void) {
        webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): done(value)
            case .failure(let error): done(["error": "\(error)"])
            }
        }
    }

    private func snapshot(_ path: String, _ done: @escaping () -> Void) {
        webView.takeSnapshot(with: nil) { image, _ in
            if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            }
            done()
        }
    }

    private func runSelfTest(_ dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) {
            FileHandle.standardError.write(Data("selftest timed out\n".utf8))
            exit(3)
        }
        // developer aid: VFD_OPEN_SHOTS=1.0,1.5,... waits for the automatic start, then freezes the opening at each
        // time (seconds) and saves a snapshot of it
        if let list = ProcessInfo.processInfo.environment["VFD_OPEN_SHOTS"] {
            var times = list.split(separator: ",").compactMap { Double($0) }
            func next() {
                guard !times.isEmpty else {
                    print("shots done")
                    exit(0)
                }
                let t = times.removeFirst()
                evaluate("window.vfdApp.holdOpening(\(t)); await new Promise(r => setTimeout(r, 450)); return true") { _ in
                    self.snapshot(dir + "/open_\(t).png") { next() }
                }
            }
            evaluate("const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const t0 = performance.now(); while (!window.vfdApp.state.power && performance.now() - t0 < 6000) await sleep(100); return window.vfdApp.state.power;") { started in
                print("started by itself:", started)
                next()
            }
            return
        }
        // developer aid: VFD_EVAL_JS=<file> runs that script in the page (after a short settle) and prints its result
        if let path = ProcessInfo.processInfo.environment["VFD_EVAL_JS"], let body = try? String(contentsOfFile: path, encoding: .utf8) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                self.evaluate(body) { result in
                    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]),
                       let text = String(data: data, encoding: .utf8) { print(text) }
                    print("[native] window.subtitle = \(self.window.subtitle)")
                    print("[native] window.level = \(self.window.level.rawValue) (floating = \(NSWindow.Level.floating.rawValue))")
                    // VFD_EVAL_SHOT=<png> also saves a snapshot of the page as the script left it
                    let finish = {
                        // VFD_EVAL_QUIT=1 leaves through the real quit path (applicationShouldTerminate), so a test can check
                        // that a setting changed a moment before quitting still reaches the settings file
                        if ProcessInfo.processInfo.environment["VFD_EVAL_QUIT"] != nil { NSApp.terminate(nil); return }
                        // give WebKit time to flush localStorage writes made by the script
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { exit(0) }
                    }
                    if let shot = ProcessInfo.processInfo.environment["VFD_EVAL_SHOT"] { self.snapshot(shot, finish) } else { finish() }
                }
            }
            return
        }
        let first = """
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const md = navigator.mediaDevices;
        const out = { title: document.title, native: !!window.VFD_NATIVE, secure: window.isSecureContext, origin: location.origin,
          getUserMedia: !!(md && md.getUserMedia), getDisplayMedia: !!(md && md.getDisplayMedia),
          sysLabel: document.querySelector('[data-action="src-tab"] span').textContent,
          viewport: [innerWidth, innerHeight], scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], stageWidth: Math.round(document.querySelector('.stage').getBoundingClientRect().width), fullscreenApi: !!document.documentElement.requestFullscreen };
        await sleep(500);
        if (!window.vfdApp.state.power) window.vfdApp.actions.power(); // the app normally starts by itself
        await sleep(5200);
        const a = window.vfdApp;
        out.power = a.state.power; out.source = a.state.source; out.ctx = a.engine.ctx && a.engine.ctx.state;
        out.bars = Array.from(a.model.bars).slice(0, 6).map(v => +v.toFixed(2));
        return out;
        """
        let second = """
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const a = window.vfdApp;
        for (let i = 0; i < 5; i++) a.actions.mode();
        for (let i = 0; i < 5; i++) a.actions.color();
        await sleep(1800);
        return { mode: a.state.modeIdx, theme: a.state.themeIdx, bars: Array.from(a.model.bars).slice(0, 4).map(v => +v.toFixed(2)) };
        """
        // Real mouse events, pushed through the window like a click would be: does the page receive them, and does the
        // element under the pointer turn out to be the key we aimed at?
        let probe = """
        window.vfdApp.panel.setAngle(-5); // the angle at which the keys used to go dead
        await new Promise(r => setTimeout(r, 250));
        window.__ev = [];
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          document.addEventListener(t, (e) => window.__ev.push(t + ':' + (e.target.closest('[data-action],[data-angle],.knob,.glass') || e.target).className + '|' + (e.target.closest('[data-action]') || {dataset: {}}).dataset.action), true);
        }
        const keys = {};
        for (const name of ['mode', 'band', 'color', 'dim', 'src-mic', 'eq']) {
          const el = document.querySelector('[data-action="' + name + '"]');
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          keys[name] = { x: Math.round(cx), y: Math.round(cy), hitOk: !!hit && hit.closest('[data-action]') === el, hit: hit && (hit.className || hit.tagName) };
        }
        return keys;
        """
        let after = """
        const a = window.vfdApp;
        return { modeIdx: a.state.modeIdx, bandCount: a.engine.bandCount, themeIdx: a.state.themeIdx, events: window.__ev, hasFocus: document.hasFocus(), visibility: document.visibilityState };
        """
        evaluate(first) { r1 in
            self.snapshot(dir + "/shot1.png") {
                self.evaluate(second) { r2 in
                    self.snapshot(dir + "/shot2.png") {
                        self.evaluate(probe) { keys in
                            var report: [String: Any] = ["first": r1, "second": r2, "keys": keys]
                            let targets = (keys as? [String: [String: Any]]) ?? [:]
                            var seq: [(String, Double, Double)] = []
                            for name in ["mode", "band", "color"] {
                                if let k = targets[name], let x = k["x"] as? Double, let y = k["y"] as? Double { seq.append((name, x, y)) }
                            }
                            self.clickSequence(seq) {
                                self.evaluate(after) { r3 in
                                    report["afterClicks"] = r3
                                    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]),
                                       let text = String(data: data, encoding: .utf8) { print(text) }
                                    exit(0)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func clickSequence(_ points: [(String, Double, Double)], _ done: @escaping () -> Void) {
        guard let first = points.first else { return done() }
        clickPage(first.1, first.2) { self.clickSequence(Array(points.dropFirst()), done) }
    }

    // A left click at a page (CSS pixel) position, delivered through the window's normal event path.
    private func clickPage(_ x: Double, _ y: Double, _ done: @escaping () -> Void) {
        let point = webView.convert(NSPoint(x: x, y: y), to: nil)
        func event(_ type: NSEvent.EventType) -> NSEvent? {
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                               pressure: type == .leftMouseDown ? 1 : 0)
        }
        if let down = event(.leftMouseDown) { window.sendEvent(down) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
            if let up = self.event(.leftMouseUp, at: point) { self.window.sendEvent(up) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: done)
        }
    }

    private func event(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent? {
        NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                           pressure: type == .leftMouseDown ? 1 : 0)
    }
}
