import Foundation

/// Ensure a macOS app is running (needed for launchd/SSH contexts where apps aren't launched by default)
func ensureAppRunning(_ appName: String) {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    proc.arguments = ["-gja", appName]
    try? proc.run()
    proc.waitUntilExit()
    Thread.sleep(forTimeInterval: 0.5)
}

/// Run an AppleScript string via /usr/bin/osascript, ensuring the target app is running first
func runAppleScript(_ script: String, app: String) throws -> String {
    ensureAppRunning(app)
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    proc.arguments = ["-e", script]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = pipe
    try proc.run()
    proc.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if proc.terminationStatus != 0 {
        throw NSError(domain: "AppleScript", code: Int(proc.terminationStatus),
                      userInfo: [NSLocalizedDescriptionKey: output])
    }
    return output
}

/// Escape a string for safe embedding in AppleScript string literals
func escapeForAppleScript(_ s: String) -> String {
    return s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
}

/// Format a Date for AppleScript's `date "..."` syntax using a fixed locale
/// (Locale.current is unreliable under launchd)
func formatDateForAppleScript(_ date: Date) -> String {
    let df = DateFormatter()
    df.locale = Locale(identifier: "en_US")
    df.dateFormat = "EEEE, MMMM d, yyyy 'at' h:mm:ss a"
    return df.string(from: date)
}
