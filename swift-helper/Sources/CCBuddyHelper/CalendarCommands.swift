import ArgumentParser
import Foundation

// Shared helpers are in AppleScriptUtils.swift

// MARK: - List

struct CalendarList: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "list")

    @Option(help: "Start date (ISO 8601)")
    var from: String

    @Option(help: "End date (ISO 8601)")
    var to: String

    func run() throws {
        guard let startDate = parseISO8601Date(from) else {
            printError("Invalid --from date: \(from)")
            return
        }
        guard let endDate = parseISO8601Date(to) else {
            printError("Invalid --to date: \(to)")
            return
        }

        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"

        let script = """
        set output to ""
        tell application "Calendar"
            set startDate to date "\(formatDateForAppleScript(startDate))"
            set endDate to date "\(formatDateForAppleScript(endDate))"
            repeat with cal in calendars
                set calName to name of cal
                set evts to (every event of cal whose start date ≥ startDate and start date < endDate)
                repeat with evt in evts
                    set evtId to uid of evt
                    set evtTitle to summary of evt
                    set evtStart to start date of evt
                    set evtEnd to end date of evt
                    set evtLoc to ""
                    try
                        set evtLoc to location of evt
                    end try
                    set evtNotes to ""
                    try
                        set evtNotes to description of evt
                    end try
                    set evtAllDay to allday event of evt
                    set output to output & evtId & "\\t" & evtTitle & "\\t" & (evtStart as «class isot» as string) & "\\t" & (evtEnd as «class isot» as string) & "\\t" & calName & "\\t" & evtLoc & "\\t" & evtNotes & "\\t" & evtAllDay & "\\n"
                end repeat
            end repeat
        end tell
        return output
        """

        let result = try runAppleScript(script, app: "Calendar")
        let events = parseCalendarOutput(result)
        printJSON(EventListResult(success: true, events: events))
    }
}

// MARK: - Search

struct CalendarSearch: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "search")

    @Option(help: "Search query")
    var query: String

    @Option(help: "Start date (ISO 8601, default: 1 year ago)")
    var from: String?

    @Option(help: "End date (ISO 8601, default: 1 year from now)")
    var to: String?

    func run() throws {
        let startDate = from.flatMap({ parseISO8601Date($0) })
            ?? Calendar.current.date(byAdding: .year, value: -1, to: Date())!
        let endDate = to.flatMap({ parseISO8601Date($0) })
            ?? Calendar.current.date(byAdding: .year, value: 1, to: Date())!

        let queryEsc = escapeForAppleScript(query.lowercased())

        let script = """
        set output to ""
        tell application "Calendar"
            set startDate to date "\(formatDateForAppleScript(startDate))"
            set endDate to date "\(formatDateForAppleScript(endDate))"
            repeat with cal in calendars
                set calName to name of cal
                set evts to (every event of cal whose start date ≥ startDate and start date < endDate)
                repeat with evt in evts
                    set evtTitle to summary of evt
                    set evtLoc to ""
                    try
                        set evtLoc to location of evt
                    end try
                    set evtNotes to ""
                    try
                        set evtNotes to description of evt
                    end try
                    set matched to false
                    considering case
                        set lowerTitle to do shell script "echo " & quoted form of evtTitle & " | tr '[:upper:]' '[:lower:]'"
                        if lowerTitle contains "\(queryEsc)" then set matched to true
                        if evtLoc is not "" then
                            set lowerLoc to do shell script "echo " & quoted form of evtLoc & " | tr '[:upper:]' '[:lower:]'"
                            if lowerLoc contains "\(queryEsc)" then set matched to true
                        end if
                    end considering
                    if matched then
                        set evtId to uid of evt
                        set evtStart to start date of evt
                        set evtEnd to end date of evt
                        set evtAllDay to allday event of evt
                        set output to output & evtId & "\\t" & evtTitle & "\\t" & (evtStart as «class isot» as string) & "\\t" & (evtEnd as «class isot» as string) & "\\t" & calName & "\\t" & evtLoc & "\\t" & evtNotes & "\\t" & evtAllDay & "\\n"
                    end if
                end repeat
            end repeat
        end tell
        return output
        """

        let result = try runAppleScript(script, app: "Calendar")
        let events = parseCalendarOutput(result)
        printJSON(EventListResult(success: true, events: events))
    }
}

// MARK: - Create

struct CalendarCreate: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "create")

    @Option(help: "Event title")
    var title: String

    @Option(help: "Start date/time (ISO 8601)")
    var start: String

    @Option(help: "End date/time (ISO 8601)")
    var end: String

    @Option(help: "Calendar name (default: default calendar)")
    var calendar: String?

    @Option(help: "Location")
    var location: String?

    @Option(help: "Notes")
    var notes: String?

    @Flag(help: "All-day event")
    var allDay: Bool = false

    func run() throws {
        guard let startDate = parseISO8601Date(start) else {
            printError("Invalid --start date: \(start)")
            return
        }
        guard let endDate = parseISO8601Date(end) else {
            printError("Invalid --end date: \(end)")
            return
        }

        let titleEsc = escapeForAppleScript(title)
        let calSpec = calendar.map { "calendar \"\(escapeForAppleScript($0))\"" } ?? "default calendar"

        let props = """
        summary:"\(titleEsc)", start date:date "\(formatDateForAppleScript(startDate))", end date:date "\(formatDateForAppleScript(endDate))", allday event:\(allDay)
        """

        let script = """
        tell application "Calendar"
            tell \(calSpec)
                set newEvent to make new event with properties {\(props)}
                \(location.map { "set location of newEvent to \"\(escapeForAppleScript($0))\"" } ?? "")
                \(notes.map { "set description of newEvent to \"\(escapeForAppleScript($0))\"" } ?? "")
                set evtId to uid of newEvent
                set evtStart to start date of newEvent
                set evtEnd to end date of newEvent
                set evtAllDay to allday event of newEvent
                set calName to name of \(calSpec)
                return evtId & "\\t" & summary of newEvent & "\\t" & (evtStart as «class isot» as string) & "\\t" & (evtEnd as «class isot» as string) & "\\t" & calName & "\\t" & ("\(escapeForAppleScript(location ?? ""))") & "\\t" & ("\(escapeForAppleScript(notes ?? ""))") & "\\t" & evtAllDay
            end tell
        end tell
        """

        let result = try runAppleScript(script, app: "Calendar")
        let events = parseCalendarOutput(result)
        if let event = events.first {
            printJSON(EventSingleResult(success: true, event: event))
        } else {
            printError("Failed to create event")
        }
    }
}

// MARK: - Update

struct CalendarUpdate: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "update")

    @Option(help: "Event UID")
    var id: String

    @Option(help: "New title")
    var title: String?

    @Option(help: "New start date/time (ISO 8601)")
    var start: String?

    @Option(help: "New end date/time (ISO 8601)")
    var end: String?

    @Option(help: "New calendar name")
    var calendar: String?

    @Option(help: "New location")
    var location: String?

    @Option(help: "New notes")
    var notes: String?

    func run() throws {
        let idEsc = escapeForAppleScript(id)
        var setLines: [String] = []
        if let t = title { setLines.append("set summary of targetEvent to \"\(escapeForAppleScript(t))\"") }
        if let s = start, let d = parseISO8601Date(s) {
            setLines.append("set start date of targetEvent to date \"\(formatDateForAppleScript(d))\"")
        }
        if let e = end, let d = parseISO8601Date(e) {
            setLines.append("set end date of targetEvent to date \"\(formatDateForAppleScript(d))\"")
        }
        if let loc = location { setLines.append("set location of targetEvent to \"\(escapeForAppleScript(loc))\"") }
        if let n = notes { setLines.append("set description of targetEvent to \"\(escapeForAppleScript(n))\"") }

        let script = """
        tell application "Calendar"
            set targetEvent to missing value
            repeat with cal in calendars
                try
                    set evts to (every event of cal whose uid = "\(idEsc)")
                    if (count of evts) > 0 then
                        set targetEvent to item 1 of evts
                        exit repeat
                    end if
                end try
            end repeat
            if targetEvent is missing value then error "Event not found with ID: \(idEsc)"
            \(setLines.joined(separator: "\n            "))
            \(calendar.map { """
            set targetCal to calendar "\(escapeForAppleScript($0))"
            move targetEvent to targetCal
            """ } ?? "")
            set evtId to uid of targetEvent
            set evtTitle to summary of targetEvent
            set evtStart to start date of targetEvent
            set evtEnd to end date of targetEvent
            set calName to name of calendar of targetEvent
            set evtLoc to ""
            try
                set evtLoc to location of targetEvent
            end try
            set evtNotes to ""
            try
                set evtNotes to description of targetEvent
            end try
            set evtAllDay to allday event of targetEvent
            return evtId & "\\t" & evtTitle & "\\t" & (evtStart as «class isot» as string) & "\\t" & (evtEnd as «class isot» as string) & "\\t" & calName & "\\t" & evtLoc & "\\t" & evtNotes & "\\t" & evtAllDay
        end tell
        """

        let result = try runAppleScript(script, app: "Calendar")
        let events = parseCalendarOutput(result)
        if let event = events.first {
            printJSON(EventSingleResult(success: true, event: event))
        } else {
            printError("Failed to update event")
        }
    }
}

// MARK: - Delete

struct CalendarDelete: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "delete")

    @Option(help: "Event UID")
    var id: String

    func run() throws {
        let idEsc = escapeForAppleScript(id)
        let script = """
        tell application "Calendar"
            repeat with cal in calendars
                try
                    set evts to (every event of cal whose uid = "\(idEsc)")
                    if (count of evts) > 0 then
                        delete item 1 of evts
                        return "ok"
                    end if
                end try
            end repeat
            error "Event not found with ID: \(idEsc)"
        end tell
        """
        _ = try runAppleScript(script, app: "Calendar")
        printJSON(SuccessResult(success: true))
    }
}

// MARK: - Helpers

private func parseCalendarOutput(_ raw: String) -> [CalendarEventOutput] {
    guard !raw.isEmpty else { return [] }
    return raw.components(separatedBy: "\n").compactMap { line in
        let line = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return nil }
        let parts = line.components(separatedBy: "\t")
        guard parts.count >= 8 else { return nil }
        return CalendarEventOutput(
            id: parts[0],
            title: parts[1],
            startDate: parts[2],
            endDate: parts[3],
            calendar: parts[4],
            location: parts[5],
            notes: parts[6],
            isAllDay: parts[7] == "true"
        )
    }
}
