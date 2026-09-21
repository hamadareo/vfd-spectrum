import AppKit
import Foundation

// What the Music app is playing, read through AppleScript (no developer token needed). Same contract as the
// helper in server.py: it never launches Music, it only asks when Music is already running.
final class NowPlaying {
    private static let script = """
    tell application "Music"
        set volumeText to (sound volume as integer) as text
        set playerStateText to (player state as text)
        if playerStateText is "stopped" then return playerStateText & tab & tab & tab & tab & tab & tab & volumeText
        try
            set theTrack to current track
            return playerStateText & tab & (name of theTrack) & tab & (artist of theTrack) & tab & (album of theTrack) & tab & (player position as integer) & tab & (duration of theTrack as integer) & tab & volumeText
        on error
            return playerStateText & tab & tab & tab & tab & tab & tab & volumeText
        end try
    end tell
    """
    // The display's transport keys. Only Music is addressed, and only these fixed commands.
    private static let controlScripts: [String: String] = [
        "playpause": "tell application \"Music\" to playpause",
        "next": "tell application \"Music\" to next track",
        "prev": "tell application \"Music\" to previous track",
        "restart": "tell application \"Music\" to set player position to 0",
        "ff": "tell application \"Music\" to fast forward",
        "rw": "tell application \"Music\" to rewind",
        "resume": "tell application \"Music\" to resume",
    ]

    // Test aid: a made-up player that only logs the transport commands, so that automated runs can never touch (or
    // reveal) what is really playing in the user's Music app. It is on with VFD_MUSIC_FAKE=1 and ALWAYS in --selftest
    // runs (a test that merely switches the page to a live input would otherwise start polling the real Music app);
    // VFD_MUSIC_REAL=1 opts a self-test back in to the real one.
    private let fake = ProcessInfo.processInfo.environment["VFD_MUSIC_FAKE"] != nil
        || (ProcessInfo.processInfo.arguments.contains("--selftest") && ProcessInfo.processInfo.environment["VFD_MUSIC_REAL"] == nil)
    private var fakeState = "playing"
    private var fakeTrack = 1
    private var fakePosition = 12.0
    private var fakeSince = Date()
    private var fakeLog: [String] = []
    private var fakeVolume = 60

    private let queue = DispatchQueue(label: "vfd.nowplaying")
    private var cached: [String: Any] = ["running": false, "state": "stopped"]
    private var cachedAt = Date.distantPast
    // Until one query has succeeded, macOS may be showing its "allow control of Music?" dialog: give the user time
    // to answer it instead of killing the script (which would also dismiss the dialog).
    private var authorised = false

    func get(_ done: @escaping ([String: Any]) -> Void) {
        queue.async {
            if Date().timeIntervalSince(self.cachedAt) > 1 {
                self.cached = self.query()
                self.cachedAt = Date()
            }
            var value = self.cached
            value["source"] = "Music"
            value["available"] = true
            done(value)
        }
    }

    func control(_ action: String, value: Int? = nil, _ done: @escaping ([String: Any]) -> Void) {
        queue.async {
            let script: String
            if action == "volume" {
                // the VOL knob: an integer 0...100, nothing else ever reaches the script text
                guard let v = value, (0...100).contains(v) else { return done(["ok": false, "error": "bad-action"]) }
                script = "tell application \"Music\" to set sound volume to \(v)"
            } else if let fixed = NowPlaying.controlScripts[action] {
                script = fixed
            } else {
                return done(["ok": false, "error": "bad-action"])
            }
            if self.fake {
                self.applyFake(action, value)
                self.cachedAt = .distantPast
                return done(["ok": true, "fake": true])
            }
            let running = !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Music").isEmpty
            guard running else { return done(["ok": false, "error": "not-running"]) }
            let r = self.run(script, timeout: self.authorised ? 4 : 40)
            if r.timedOut { return done(["ok": false, "error": "timeout"]) }
            if r.status != 0 {
                return done(["ok": false, "error": r.err.contains("-1743") ? "not-authorized" : String(r.err.prefix(160))])
            }
            self.authorised = true
            self.cachedAt = .distantPast // the next poll must see the new state
            done(["ok": true])
        }
    }

    private func fakeElapsed() -> Double {
        fakeState == "playing" ? fakePosition + Date().timeIntervalSince(fakeSince) : fakePosition
    }

    private func applyFake(_ action: String, _ value: Int?) {
        fakeLog.append(action == "volume" ? "volume:\(value ?? -1)" : action)
        let now = fakeElapsed()
        fakePosition = now
        fakeSince = Date()
        switch action {
        case "playpause": fakeState = fakeState == "playing" ? "paused" : "playing"
        case "next": fakeTrack += 1; fakePosition = 0
        case "prev": fakeTrack = max(1, fakeTrack - 1); fakePosition = 0
        case "restart": fakePosition = 0
        case "ff": fakeState = "fast forwarding"
        case "rw": fakeState = "rewinding"
        case "resume": fakeState = "playing"
        case "volume": fakeVolume = value ?? fakeVolume
        default: break
        }
    }

    private func query() -> [String: Any] {
        if fake {
            return ["running": true, "state": fakeState, "title": "Fake Track \(fakeTrack)", "artist": "Fake Artist", "album": "Fake Album",
                    "position": Int(fakeElapsed()), "duration": 215, "volume": fakeVolume, "fakeLog": fakeLog]
        }
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Music").isEmpty
        guard running else { return ["running": false, "state": "stopped"] }
        let r = run(NowPlaying.script, timeout: authorised ? 4 : 40)
        if r.timedOut { return ["running": true, "state": "unknown", "error": "timeout"] }
        if r.status != 0 {
            // -1743: the user has not (yet) allowed this app to control Music
            return ["running": true, "state": "unknown", "error": r.err.contains("-1743") ? "not-authorized" : String(r.err.prefix(160))]
        }
        authorised = true
        let parts = r.out.trimmingCharacters(in: .newlines).components(separatedBy: "\t")
        var info: [String: Any] = ["running": true, "state": parts[0].isEmpty ? "unknown" : parts[0]]
        if parts.count >= 4 {
            info["title"] = parts[1]
            info["artist"] = parts[2]
            info["album"] = parts[3]
        }
        if parts.count >= 6, let pos = Int(parts[4]), let dur = Int(parts[5]) {
            info["position"] = pos
            info["duration"] = dur
        }
        if parts.count >= 7, let vol = Int(parts[6]) { info["volume"] = vol }
        return info
    }

    private func run(_ script: String, timeout: TimeInterval) -> (status: Int32, out: String, err: String, timedOut: Bool) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        let o = Pipe()
        let e = Pipe()
        p.standardOutput = o
        p.standardError = e
        let finished = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in finished.signal() }
        do { try p.run() } catch { return (-1, "", "\(error)", false) }
        var timedOut = false
        if finished.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            p.terminate()
            _ = finished.wait(timeout: .now() + 1)
        }
        let out = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: e.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (p.terminationStatus, out, err, timedOut)
    }
}
