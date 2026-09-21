import Foundation
import Network

// A tiny static-file HTTP server bound to 127.0.0.1 only. The page has to come from an http origin on the
// loopback interface (a secure context) for getUserMedia / AudioContext to behave like in a browser, and the
// same server hands out the Music "now playing" JSON that the web app polls.
final class LocalServer {
    private let root: URL
    private let nowPlaying: NowPlaying
    private let queue = DispatchQueue(label: "vfd.server")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    init(root: URL, nowPlaying: NowPlaying) {
        self.root = root.standardizedFileURL
        self.nowPlaying = nowPlaying
    }

    // Tries `preferredPort` first (a stable port keeps the page's saved settings), then the next ones.
    func start(preferredPort: UInt16) -> UInt16? {
        for candidate in preferredPort..<(preferredPort + 20) {
            if let l = bind(candidate) {
                listener = l
                port = candidate
                return candidate
            }
        }
        return nil
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func bind(_ port: UInt16) -> NWListener? {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return nil }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: nwPort)
        guard let l = try? NWListener(using: params) else { return nil }
        let ready = DispatchSemaphore(value: 0)
        let box = StateBox()
        l.stateUpdateHandler = { state in
            switch state {
            case .ready:
                box.ok = true
                ready.signal()
            case .failed, .cancelled:
                ready.signal()
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 1.0)
        if !box.ok {
            l.cancel()
            return nil
        }
        return l
    }

    private final class StateBox { var ok = false }

    // ---- connections -----------------------------------------------------------------------

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        read(c, Data())
    }

    private func read(_ c: NWConnection, _ acc: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                c.cancel()
                return
            }
            var buf = acc
            if let d = data { buf.append(d) }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = buf.subdata(in: 0..<end.lowerBound)
                let need = LocalServer.contentLength(head)
                if need > 4096 {
                    self.respond(c, 413, "Payload Too Large")
                } else if buf.count - end.upperBound < need {
                    self.read(c, buf) // the body is still on its way
                } else {
                    self.handle(c, head: head, body: buf.subdata(in: end.upperBound..<(end.upperBound + need)))
                }
            } else if error != nil || isComplete || buf.count > 32768 {
                c.cancel()
            } else {
                self.read(c, buf)
            }
        }
    }

    private func respond(_ c: NWConnection, _ status: Int, _ reason: String, type: String = "text/plain; charset=utf-8",
                         body: Data = Data(), headers: [String: String] = [:], headOnly: Bool = false) {
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        if !headOnly { out.append(body) }
        c.send(content: out, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.cancel() })
    }

    private static func contentLength(_ head: Data) -> Int {
        guard let text = String(data: head, encoding: .utf8) else { return 0 }
        for line in text.components(separatedBy: "\r\n").dropFirst() where line.lowercased().hasPrefix("content-length:") {
            return Int(line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) ?? 0
        }
        return 0
    }

    private func handle(_ c: NWConnection, head: Data, body: Data) {
        guard let text = String(data: head, encoding: .utf8) else { return respond(c, 400, "Bad Request") }
        let lines = text.components(separatedBy: "\r\n")
        let request = (lines.first ?? "").split(separator: " ")
        guard request.count >= 2 else { return respond(c, 400, "Bad Request") }
        let method = String(request[0])
        let target = String(request[1])
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        guard method == "GET" || method == "HEAD" || method == "POST" else { return respond(c, 405, "Method Not Allowed") }
        let headOnly = method == "HEAD"

        // refuse DNS-rebinding style requests: the Host header must be the loopback name we listen on
        let host = (headers["host"] ?? "").split(separator: ":").first.map(String.init) ?? ""
        guard host == "127.0.0.1" || host == "localhost" else { return respond(c, 403, "Forbidden") }

        let path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])

        // Transport keys for the Music app. The only POST endpoint, and it must come from this very page: same
        // origin plus a custom header, which a foreign page cannot add without a CORS pre-flight (never answered).
        if method == "POST" {
            guard path == "/api/control" else { return respond(c, 404, "Not Found") }
            let same = ["http://127.0.0.1:\(port)", "http://localhost:\(port)"]
            if let o = headers["origin"], !same.contains(o) { return respond(c, 403, "Forbidden") }
            guard headers["x-vfd-control"] == "1" else { return respond(c, 403, "Forbidden") }
            guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let action = obj["action"] as? String else {
                return respond(c, 400, "Bad Request")
            }
            nowPlaying.control(action, value: obj["value"] as? Int) { [weak self] result in
                let json = (try? JSONSerialization.data(withJSONObject: result)) ?? Data("{}".utf8)
                let bad = (result["error"] as? String) == "bad-action"
                self?.respond(c, bad ? 400 : 200, bad ? "Bad Request" : "OK", type: "application/json; charset=utf-8", body: json)
            }
            return
        }

        if path == "/api/nowplaying" {
            let origin = headers["origin"]
            let sameOrigin = ["http://127.0.0.1:\(port)", "http://localhost:\(port)"]
            if let o = origin, !sameOrigin.contains(o) { return respond(c, 403, "Forbidden") }
            nowPlaying.get { [weak self] info in
                guard let self = self else { return }
                let json = (try? JSONSerialization.data(withJSONObject: info)) ?? Data("{}".utf8)
                var extra: [String: String] = [:]
                if let o = origin {
                    extra["Access-Control-Allow-Origin"] = o
                    extra["Vary"] = "Origin"
                }
                self.respond(c, 200, "OK", type: "application/json; charset=utf-8", body: json, headers: extra, headOnly: headOnly)
            }
            return
        }

        let rel = path == "/" ? "index.html" : String(path.dropFirst())
        guard let decoded = rel.removingPercentEncoding, !decoded.contains("\0") else { return respond(c, 400, "Bad Request") }
        let file = root.appendingPathComponent(decoded).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/") else { return respond(c, 403, "Forbidden") }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue,
              let data = try? Data(contentsOf: file) else { return respond(c, 404, "Not Found") }
        respond(c, 200, "OK", type: LocalServer.mime(file.pathExtension), body: data, headOnly: headOnly)
    }

    private static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}
