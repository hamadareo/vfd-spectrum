import AppKit

// `VFD Spectrum --selftest <dir>` loads the page, powers the unit on, writes screenshots into <dir>, prints a
// JSON report on stdout and quits. Used to check a build without touching the real user interface.
let selfTestDir: String? = {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--selftest"), i + 1 < a.count { return a[i + 1] }
    return nil
}()

let application = NSApplication.shared
let delegate = AppDelegate(selfTestDir: selfTestDir)
application.delegate = delegate
application.setActivationPolicy(selfTestDir == nil ? .regular : .accessory)
application.run()
