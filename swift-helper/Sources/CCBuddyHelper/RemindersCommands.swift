import ArgumentParser
import EventKit
import Foundation

private let reminderStore = EKEventStore()

private func requestRemindersAccess() throws {
    let semaphore = DispatchSemaphore(value: 0)
    var accessGranted = false
    var accessError: Error?

    if #available(macOS 14.0, *) {
        reminderStore.requestFullAccessToReminders { granted, error in
            accessGranted = granted
            accessError = error
            semaphore.signal()
        }
    } else {
        reminderStore.requestAccess(to: .reminder) { granted, error in
            accessGranted = granted
            accessError = error
            semaphore.signal()
        }
    }

    semaphore.wait()

    if let err = accessError {
        throw err
    }
    if !accessGranted {
        printError("Reminders access denied. Grant permission in System Settings > Privacy & Security > Reminders.")
        Foundation.exit(1)
    }
}

private func reminderToOutput(_ reminder: EKReminder) -> ReminderOutput {
    var dueDateString: String? = nil
    if let components = reminder.dueDateComponents {
        if let date = Calendar.current.date(from: components) {
            dueDateString = iso8601Formatter.string(from: date)
        }
    }
    return ReminderOutput(
        id: reminder.calendarItemIdentifier,
        title: reminder.title ?? "",
        isCompleted: reminder.isCompleted,
        dueDate: dueDateString,
        list: reminder.calendar?.title ?? "",
        notes: reminder.notes ?? "",
        priority: reminder.priority
    )
}

private func fetchAllReminders(from calendars: [EKCalendar]?) -> [EKReminder] {
    let semaphore = DispatchSemaphore(value: 0)
    var fetchedReminders: [EKReminder] = []

    let predicate = reminderStore.predicateForReminders(in: calendars)
    reminderStore.fetchReminders(matching: predicate) { reminders in
        fetchedReminders = reminders ?? []
        semaphore.signal()
    }

    semaphore.wait()
    return fetchedReminders
}

private func findReminder(byId id: String) -> EKReminder? {
    return reminderStore.calendarItem(withIdentifier: id) as? EKReminder
}

// MARK: - List

struct RemindersList: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "list")

    @Option(help: "Reminder list name (default: all lists)")
    var list: String?

    @Flag(help: "Include completed reminders")
    var showCompleted: Bool = false

    func run() throws {
        try requestRemindersAccess()

        var targetCalendars: [EKCalendar]? = nil
        let reminderCalendars = reminderStore.calendars(for: .reminder)

        if let listName = list {
            if let cal = reminderCalendars.first(where: { $0.title == listName }) {
                targetCalendars = [cal]
            } else {
                printError("Reminder list '\(listName)' not found. Available: \(reminderCalendars.map(\.title).joined(separator: ", "))")
                return
            }
        }

        var reminders = fetchAllReminders(from: targetCalendars)

        if !showCompleted {
            reminders = reminders.filter { !$0.isCompleted }
        }

        printJSON(ReminderListResult(success: true, reminders: reminders.map(reminderToOutput)))
    }
}

// MARK: - Create

struct RemindersCreate: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "create")

    @Option(help: "Reminder title")
    var title: String

    @Option(help: "Due date/time (ISO 8601)")
    var due: String?

    @Option(help: "Reminder list name (default: default list)")
    var list: String?

    @Option(help: "Notes")
    var notes: String?

    @Option(help: "Priority (0=none, 1=high, 5=medium, 9=low)")
    var priority: Int?

    func run() throws {
        try requestRemindersAccess()

        let reminder = EKReminder(eventStore: reminderStore)
        reminder.title = title

        if let n = notes { reminder.notes = n }
        if let p = priority { reminder.priority = p }

        if let dueStr = due {
            guard let dueDate = iso8601Formatter.date(from: dueStr) else {
                printError("Invalid --due date: \(dueStr)")
                return
            }
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second],
                from: dueDate
            )
        }

        let reminderCalendars = reminderStore.calendars(for: .reminder)
        if let listName = list {
            if let cal = reminderCalendars.first(where: { $0.title == listName }) {
                reminder.calendar = cal
            } else {
                printError("Reminder list '\(listName)' not found. Available: \(reminderCalendars.map(\.title).joined(separator: ", "))")
                return
            }
        } else {
            reminder.calendar = reminderStore.defaultCalendarForNewReminders()
        }

        try reminderStore.save(reminder, commit: true)
        printJSON(ReminderSingleResult(success: true, reminder: reminderToOutput(reminder)))
    }
}

// MARK: - Complete

struct RemindersComplete: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "complete")

    @Option(help: "Reminder ID")
    var id: String

    func run() throws {
        try requestRemindersAccess()

        guard let reminder = findReminder(byId: id) else {
            printError("Reminder not found with ID: \(id)")
            return
        }

        reminder.isCompleted = true
        reminder.completionDate = Date()
        try reminderStore.save(reminder, commit: true)
        printJSON(ReminderSingleResult(success: true, reminder: reminderToOutput(reminder)))
    }
}

// MARK: - Delete

struct RemindersDelete: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "delete")

    @Option(help: "Reminder ID")
    var id: String

    func run() throws {
        try requestRemindersAccess()

        guard let reminder = findReminder(byId: id) else {
            printError("Reminder not found with ID: \(id)")
            return
        }

        try reminderStore.remove(reminder, commit: true)
        printJSON(SuccessResult(success: true))
    }
}
