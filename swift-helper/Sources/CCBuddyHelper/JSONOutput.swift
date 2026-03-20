import Foundation

struct ReminderOutput: Codable {
    let id: String
    let title: String
    let isCompleted: Bool
    let dueDate: String?
    let list: String
    let notes: String
    let priority: Int
}

struct ReminderListResult: Codable {
    let success: Bool
    let reminders: [ReminderOutput]
}

struct ReminderSingleResult: Codable {
    let success: Bool
    let reminder: ReminderOutput
}

struct CalendarEventOutput: Codable {
    let id: String
    let title: String
    let startDate: String
    let endDate: String
    let calendar: String
    let location: String
    let notes: String
    let isAllDay: Bool
}

struct EventListResult: Codable {
    let success: Bool
    let events: [CalendarEventOutput]
}

struct EventSingleResult: Codable {
    let success: Bool
    let event: CalendarEventOutput
}

struct SuccessResult: Codable {
    let success: Bool
}

struct ErrorResult: Codable {
    let success: Bool
    let error: String
}

let iso8601Formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

let outputEncoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    return e
}()

func printJSON<T: Encodable>(_ value: T) {
    let data = try! outputEncoder.encode(value)
    print(String(data: data, encoding: .utf8)!)
}

func printError(_ message: String) {
    printJSON(ErrorResult(success: false, error: message))
}
