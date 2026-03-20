# Apple Calendar Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Calendar CRUD operations via a Swift CLI binary (EventKit) exposed as MCP tools through `@ccbuddy/apple`.

**Architecture:** Swift CLI binary (`ccbuddy-helper`) uses EventKit for fast Calendar access (<10ms). New `@ccbuddy/apple` TypeScript package wraps it with `SwiftBridge` + `AppleCalendarService`. MCP server gets `--apple-helper` arg and handler branches for 5 calendar tools. Bootstrap wires the helper path through to the MCP server args.

**Tech Stack:** Swift 5.9+ (ArgumentParser, EventKit), TypeScript, vitest

**Spec:** `docs/superpowers/specs/2026-03-19-apple-calendar-design.md`

---

## Chunk 1: Swift CLI Binary

### Task 1: Create Swift Package skeleton

**Files:**
- Create: `swift-helper/Package.swift`
- Create: `swift-helper/Sources/CCBuddyHelper/main.swift`
- Create: `swift-helper/Sources/CCBuddyHelper/JSONOutput.swift`

- [ ] **Step 1: Create Package.swift**

Create `swift-helper/Package.swift`:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CCBuddyHelper",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.3.0"),
    ],
    targets: [
        .executableTarget(
            name: "ccbuddy-helper",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/CCBuddyHelper"
        ),
    ]
)
```

- [ ] **Step 2: Create JSONOutput.swift with Codable structs**

Create `swift-helper/Sources/CCBuddyHelper/JSONOutput.swift`:

```swift
import Foundation

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
```

- [ ] **Step 3: Create main.swift with argument parser skeleton**

Create `swift-helper/Sources/CCBuddyHelper/main.swift`:

```swift
import ArgumentParser
import EventKit
import Foundation

@main
struct CCBuddyHelper: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ccbuddy-helper",
        abstract: "CCBuddy native macOS helper",
        subcommands: [CalendarCommand.self]
    )
}

struct CalendarCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "calendar",
        abstract: "Calendar operations",
        subcommands: [
            CalendarList.self,
            CalendarSearch.self,
            CalendarCreate.self,
            CalendarUpdate.self,
            CalendarDelete.self,
        ]
    )
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd swift-helper && swift build 2>&1`
Expected: Resolves dependencies and builds (may show warnings, no errors)

- [ ] **Step 5: Commit**

```bash
git add swift-helper/Package.swift swift-helper/Sources/
git commit -m "feat(swift-helper): create Swift package skeleton with ArgumentParser"
```

---

### Task 2: Implement Calendar subcommands

**Files:**
- Create: `swift-helper/Sources/CCBuddyHelper/CalendarCommands.swift`
- Modify: `swift-helper/Sources/CCBuddyHelper/main.swift` (remove stub subcommand structs, they move to CalendarCommands.swift)

- [ ] **Step 1: Create CalendarCommands.swift with shared helper**

Create `swift-helper/Sources/CCBuddyHelper/CalendarCommands.swift`:

```swift
import ArgumentParser
import EventKit
import Foundation

// Shared event store — reused across subcommands in a single process invocation
private let store = EKEventStore()

private func requestAccess() throws {
    let semaphore = DispatchSemaphore(value: 0)
    var accessGranted = false
    var accessError: Error?

    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, error in
            accessGranted = granted
            accessError = error
            semaphore.signal()
        }
    } else {
        store.requestAccess(to: .event) { granted, error in
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
        printError("Calendar access denied. Grant permission in System Settings > Privacy & Security > Calendars.")
        Foundation.exit(1)
    }
}

private func eventToOutput(_ event: EKEvent) -> CalendarEventOutput {
    CalendarEventOutput(
        id: event.calendarItemExternalIdentifier ?? "",
        title: event.title ?? "",
        startDate: iso8601Formatter.string(from: event.startDate),
        endDate: iso8601Formatter.string(from: event.endDate),
        calendar: event.calendar?.title ?? "",
        location: event.location ?? "",
        notes: event.notes ?? "",
        isAllDay: event.isAllDay
    )
}

private func findEvent(byExternalId id: String) -> EKEvent? {
    // Search ±5 years to find the event
    let start = Calendar.current.date(byAdding: .year, value: -5, to: Date())!
    let end = Calendar.current.date(byAdding: .year, value: 5, to: Date())!
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: predicate)
    return events.first { $0.calendarItemExternalIdentifier == id }
}

// MARK: - List

struct CalendarList: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "list")

    @Option(help: "Start date (ISO 8601)")
    var from: String

    @Option(help: "End date (ISO 8601)")
    var to: String

    func run() throws {
        try requestAccess()

        guard let startDate = iso8601Formatter.date(from: from) else {
            printError("Invalid --from date: \(from)")
            return
        }
        guard let endDate = iso8601Formatter.date(from: to) else {
            printError("Invalid --to date: \(to)")
            return
        }

        let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
        let events = store.events(matching: predicate)

        printJSON(EventListResult(
            success: true,
            events: events.map(eventToOutput)
        ))
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
        try requestAccess()

        let startDate = from.flatMap(iso8601Formatter.date(from:))
            ?? Calendar.current.date(byAdding: .year, value: -1, to: Date())!
        let endDate = to.flatMap(iso8601Formatter.date(from:))
            ?? Calendar.current.date(byAdding: .year, value: 1, to: Date())!

        let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
        let events = store.events(matching: predicate)

        let queryLower = query.lowercased()
        let filtered = events.filter { event in
            (event.title?.lowercased().contains(queryLower) ?? false) ||
            (event.location?.lowercased().contains(queryLower) ?? false) ||
            (event.notes?.lowercased().contains(queryLower) ?? false)
        }

        printJSON(EventListResult(
            success: true,
            events: filtered.map(eventToOutput)
        ))
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
        try requestAccess()

        guard let startDate = iso8601Formatter.date(from: start) else {
            printError("Invalid --start date: \(start)")
            return
        }
        guard let endDate = iso8601Formatter.date(from: end) else {
            printError("Invalid --end date: \(end)")
            return
        }

        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = startDate
        event.endDate = endDate
        event.isAllDay = allDay

        if let loc = location { event.location = loc }
        if let n = notes { event.notes = n }

        if let calName = calendar {
            let calendars = store.calendars(for: .event)
            if let cal = calendars.first(where: { $0.title == calName }) {
                event.calendar = cal
            } else {
                printError("Calendar '\(calName)' not found. Available: \(calendars.map(\.title).joined(separator: ", "))")
                return
            }
        } else {
            event.calendar = store.defaultCalendarForNewEvents
        }

        try store.save(event, span: .thisEvent)

        printJSON(EventSingleResult(success: true, event: eventToOutput(event)))
    }
}

// MARK: - Update

struct CalendarUpdate: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "update")

    @Option(help: "Event external ID")
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
        try requestAccess()

        guard let event = findEvent(byExternalId: id) else {
            printError("Event not found with ID: \(id)")
            return
        }

        if let t = title { event.title = t }
        if let s = start {
            guard let d = iso8601Formatter.date(from: s) else {
                printError("Invalid --start date: \(s)")
                return
            }
            event.startDate = d
        }
        if let e = end {
            guard let d = iso8601Formatter.date(from: e) else {
                printError("Invalid --end date: \(e)")
                return
            }
            event.endDate = d
        }
        if let loc = location { event.location = loc }
        if let n = notes { event.notes = n }
        if let calName = calendar {
            let calendars = store.calendars(for: .event)
            if let cal = calendars.first(where: { $0.title == calName }) {
                event.calendar = cal
            } else {
                printError("Calendar '\(calName)' not found")
                return
            }
        }

        try store.save(event, span: .thisEvent)

        printJSON(EventSingleResult(success: true, event: eventToOutput(event)))
    }
}

// MARK: - Delete

struct CalendarDelete: ParsableCommand {
    static let configuration = CommandConfiguration(commandName: "delete")

    @Option(help: "Event external ID")
    var id: String

    func run() throws {
        try requestAccess()

        guard let event = findEvent(byExternalId: id) else {
            printError("Event not found with ID: \(id)")
            return
        }

        try store.remove(event, span: .thisEvent)
        printJSON(SuccessResult(success: true))
    }
}
```

- [ ] **Step 2: Remove stub subcommand structs from main.swift**

Update `swift-helper/Sources/CCBuddyHelper/main.swift` — remove the stub `CalendarList`, `CalendarSearch`, `CalendarCreate`, `CalendarUpdate`, `CalendarDelete` structs if they were defined there. The subcommand references in `CalendarCommand.configuration` now resolve to `CalendarCommands.swift`.

- [ ] **Step 3: Build release binary**

Run: `cd swift-helper && swift build -c release 2>&1`
Expected: Build succeeds, binary at `.build/release/ccbuddy-helper`

- [ ] **Step 4: Manual smoke test**

Run: `cd swift-helper && .build/release/ccbuddy-helper calendar list --from 2026-03-19T00:00:00Z --to 2026-03-20T00:00:00Z`
Expected: JSON output with today's events (or empty `events` array). First run triggers TCC permission dialog — click "OK".

- [ ] **Step 5: Commit**

```bash
git add swift-helper/Sources/CCBuddyHelper/CalendarCommands.swift
git commit -m "feat(swift-helper): implement Calendar CRUD subcommands with EventKit"
```

---

## Chunk 2: @ccbuddy/apple Package

### Task 3: Create package scaffold

**Files:**
- Create: `packages/apple/package.json`
- Create: `packages/apple/tsconfig.json`
- Create: `packages/apple/src/index.ts`

- [ ] **Step 1: Create package.json**

Create `packages/apple/package.json`:

```json
{
  "name": "@ccbuddy/apple",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@ccbuddy/core": "*"
  },
  "devDependencies": {
    "@types/node": "^22",
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/apple/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"],
  "references": [
    { "path": "../core" }
  ]
}
```

- [ ] **Step 3: Create empty index.ts**

Create `packages/apple/src/index.ts`:

```typescript
export { SwiftBridge } from './swift-bridge.js';
export { AppleCalendarService, type CalendarEvent, type CreateEventParams, type UpdateEventParams } from './calendar-service.js';
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `@ccbuddy/apple` linked in workspace

- [ ] **Step 5: Commit**

```bash
git add packages/apple/
git commit -m "feat(apple): create @ccbuddy/apple package scaffold"
```

---

### Task 4: Implement SwiftBridge

**Files:**
- Create: `packages/apple/src/swift-bridge.ts`
- Create: `packages/apple/src/__tests__/swift-bridge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/apple/src/__tests__/swift-bridge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { SwiftBridge } from '../swift-bridge.js';

describe('SwiftBridge', () => {
  let bridge: SwiftBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new SwiftBridge('/path/to/ccbuddy-helper');
  });

  it('calls execFile with correct binary path and args', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: true, events: [] }), '');
    });

    await bridge.exec(['calendar', 'list', '--from', '2026-01-01', '--to', '2026-01-02']);

    expect(mockExecFile).toHaveBeenCalledWith(
      '/path/to/ccbuddy-helper',
      ['calendar', 'list', '--from', '2026-01-01', '--to', '2026-01-02'],
      expect.objectContaining({ timeout: 10000 }),
      expect.any(Function),
    );
  });

  it('parses JSON stdout on success', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: true, events: [{ id: '1', title: 'Test' }] }), '');
    });

    const result = await bridge.exec(['calendar', 'list']);
    expect(result.success).toBe(true);
    expect((result as any).events).toHaveLength(1);
  });

  it('parses JSON error from stdout', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: false, error: 'Event not found' }), '');
    });

    const result = await bridge.exec(['calendar', 'delete', '--id', 'bad']);
    expect(result.success).toBe(false);
    expect((result as any).error).toBe('Event not found');
  });

  it('throws on non-JSON stdout', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, 'not json', '');
    });

    await expect(bridge.exec(['calendar', 'list'])).rejects.toThrow('Failed to parse');
  });

  it('throws on execFile error with ENOENT', async () => {
    const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(err, '', '');
    });

    await expect(bridge.exec(['calendar', 'list'])).rejects.toThrow(
      'ccbuddy-helper not compiled',
    );
  });

  it('throws on generic execFile error', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('timeout'), '', '');
    });

    await expect(bridge.exec(['calendar', 'list'])).rejects.toThrow('timeout');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/apple/src/__tests__/swift-bridge.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SwiftBridge**

Create `packages/apple/src/swift-bridge.ts`:

```typescript
import { execFile } from 'node:child_process';

export class SwiftBridge {
  private readonly helperPath: string;
  private readonly timeoutMs: number;

  constructor(helperPath: string, timeoutMs = 10000) {
    this.helperPath = helperPath;
    this.timeoutMs = timeoutMs;
  }

  exec(args: string[]): Promise<{ success: boolean; [key: string]: unknown }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.helperPath,
        args,
        { timeout: this.timeoutMs },
        (err, stdout, _stderr) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(new Error(
                `ccbuddy-helper not compiled — run 'swift build -c release' in swift-helper/`
              ));
              return;
            }
            reject(err);
            return;
          }

          try {
            const result = JSON.parse(stdout);
            resolve(result);
          } catch {
            reject(new Error(`Failed to parse ccbuddy-helper output: ${stdout.slice(0, 200)}`));
          }
        },
      );
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/apple/src/__tests__/swift-bridge.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/apple/src/swift-bridge.ts packages/apple/src/__tests__/swift-bridge.test.ts
git commit -m "feat(apple): implement SwiftBridge with execFile wrapper"
```

---

### Task 5: Implement AppleCalendarService

**Files:**
- Create: `packages/apple/src/calendar-service.ts`
- Create: `packages/apple/src/__tests__/calendar-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/apple/src/__tests__/calendar-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppleCalendarService } from '../calendar-service.js';
import type { SwiftBridge } from '../swift-bridge.js';

function createMockBridge(): SwiftBridge & { exec: ReturnType<typeof vi.fn> } {
  return { exec: vi.fn() } as any;
}

describe('AppleCalendarService', () => {
  let bridge: ReturnType<typeof createMockBridge>;
  let service: AppleCalendarService;

  beforeEach(() => {
    bridge = createMockBridge();
    service = new AppleCalendarService(bridge);
  });

  describe('listEvents()', () => {
    it('calls bridge with calendar list args', async () => {
      bridge.exec.mockResolvedValue({ success: true, events: [] });

      const result = await service.listEvents('2026-03-19T00:00:00Z', '2026-03-20T00:00:00Z');

      expect(bridge.exec).toHaveBeenCalledWith([
        'calendar', 'list', '--from', '2026-03-19T00:00:00Z', '--to', '2026-03-20T00:00:00Z',
      ]);
      expect(result).toEqual([]);
    });
  });

  describe('searchEvents()', () => {
    it('calls bridge with calendar search args', async () => {
      bridge.exec.mockResolvedValue({ success: true, events: [{ id: '1', title: 'Dentist' }] });

      const result = await service.searchEvents('dentist');

      expect(bridge.exec).toHaveBeenCalledWith([
        'calendar', 'search', '--query', 'dentist',
      ]);
      expect(result).toHaveLength(1);
    });

    it('passes optional date range', async () => {
      bridge.exec.mockResolvedValue({ success: true, events: [] });

      await service.searchEvents('meeting', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z');

      expect(bridge.exec).toHaveBeenCalledWith([
        'calendar', 'search', '--query', 'meeting',
        '--from', '2026-01-01T00:00:00Z', '--to', '2026-06-01T00:00:00Z',
      ]);
    });
  });

  describe('createEvent()', () => {
    it('calls bridge with create args', async () => {
      bridge.exec.mockResolvedValue({
        success: true,
        event: { id: 'new1', title: 'Meeting', startDate: '2026-03-20T14:00:00Z', endDate: '2026-03-20T15:00:00Z', calendar: 'Work', location: '', notes: '', isAllDay: false },
      });

      const result = await service.createEvent({
        title: 'Meeting',
        start: '2026-03-20T14:00:00Z',
        end: '2026-03-20T15:00:00Z',
        calendar: 'Work',
      });

      expect(bridge.exec).toHaveBeenCalledWith([
        'calendar', 'create',
        '--title', 'Meeting',
        '--start', '2026-03-20T14:00:00Z',
        '--end', '2026-03-20T15:00:00Z',
        '--calendar', 'Work',
      ]);
      expect(result.id).toBe('new1');
    });

    it('includes optional fields when provided', async () => {
      bridge.exec.mockResolvedValue({
        success: true,
        event: { id: 'new2', title: 'Birthday', startDate: '', endDate: '', calendar: '', location: 'Home', notes: 'Party', isAllDay: true },
      });

      await service.createEvent({
        title: 'Birthday',
        start: '2026-04-01T00:00:00Z',
        end: '2026-04-02T00:00:00Z',
        location: 'Home',
        notes: 'Party',
        allDay: true,
      });

      const args = bridge.exec.mock.calls[0][0] as string[];
      expect(args).toContain('--location');
      expect(args).toContain('--notes');
      expect(args).toContain('--all-day');
    });
  });

  describe('updateEvent()', () => {
    it('calls bridge with update args', async () => {
      bridge.exec.mockResolvedValue({
        success: true,
        event: { id: 'abc', title: 'Updated', startDate: '', endDate: '', calendar: '', location: '', notes: '', isAllDay: false },
      });

      await service.updateEvent('abc', { title: 'Updated' });

      expect(bridge.exec).toHaveBeenCalledWith([
        'calendar', 'update', '--id', 'abc', '--title', 'Updated',
      ]);
    });
  });

  describe('deleteEvent()', () => {
    it('calls bridge with delete args', async () => {
      bridge.exec.mockResolvedValue({ success: true });

      await service.deleteEvent('abc');

      expect(bridge.exec).toHaveBeenCalledWith(['calendar', 'delete', '--id', 'abc']);
    });

    it('throws when bridge returns error', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'Event not found' });

      await expect(service.deleteEvent('bad')).rejects.toThrow('Event not found');
    });
  });

  describe('getToolDefinitions()', () => {
    it('returns 5 tool definitions', () => {
      const tools = service.getToolDefinitions();
      expect(tools).toHaveLength(5);
      const names = tools.map(t => t.name);
      expect(names).toContain('apple_calendar_list');
      expect(names).toContain('apple_calendar_search');
      expect(names).toContain('apple_calendar_create');
      expect(names).toContain('apple_calendar_update');
      expect(names).toContain('apple_calendar_delete');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/apple/src/__tests__/calendar-service.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AppleCalendarService**

Create `packages/apple/src/calendar-service.ts`:

```typescript
import type { SwiftBridge } from './swift-bridge.js';
import type { ToolDescription } from '@ccbuddy/core';

export interface CalendarEvent {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  calendar: string;
  location: string;
  notes: string;
  isAllDay: boolean;
}

export interface CreateEventParams {
  title: string;
  start: string;
  end: string;
  calendar?: string;
  location?: string;
  notes?: string;
  allDay?: boolean;
}

export interface UpdateEventParams {
  title?: string;
  start?: string;
  end?: string;
  calendar?: string;
  location?: string;
  notes?: string;
}

export class AppleCalendarService {
  private readonly bridge: SwiftBridge;

  constructor(bridge: SwiftBridge) {
    this.bridge = bridge;
  }

  async listEvents(from: string, to: string): Promise<CalendarEvent[]> {
    const result = await this.bridge.exec(['calendar', 'list', '--from', from, '--to', to]);
    return (result as any).events ?? [];
  }

  async searchEvents(query: string, from?: string, to?: string): Promise<CalendarEvent[]> {
    const args = ['calendar', 'search', '--query', query];
    if (from && to) {
      args.push('--from', from, '--to', to);
    }
    const result = await this.bridge.exec(args);
    return (result as any).events ?? [];
  }

  async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
    const args = [
      'calendar', 'create',
      '--title', params.title,
      '--start', params.start,
      '--end', params.end,
    ];
    if (params.calendar) args.push('--calendar', params.calendar);
    if (params.location) args.push('--location', params.location);
    if (params.notes) args.push('--notes', params.notes);
    if (params.allDay) args.push('--all-day');

    const result = await this.bridge.exec(args);
    this.assertSuccess(result);
    return (result as any).event;
  }

  async updateEvent(id: string, params: UpdateEventParams): Promise<CalendarEvent> {
    const args = ['calendar', 'update', '--id', id];
    if (params.title) args.push('--title', params.title);
    if (params.start) args.push('--start', params.start);
    if (params.end) args.push('--end', params.end);
    if (params.calendar) args.push('--calendar', params.calendar);
    if (params.location) args.push('--location', params.location);
    if (params.notes) args.push('--notes', params.notes);

    const result = await this.bridge.exec(args);
    this.assertSuccess(result);
    return (result as any).event;
  }

  async deleteEvent(id: string): Promise<void> {
    const result = await this.bridge.exec(['calendar', 'delete', '--id', id]);
    this.assertSuccess(result);
  }

  getToolDefinitions(): ToolDescription[] {
    return [
      {
        name: 'apple_calendar_list',
        description: 'List calendar events in a date range.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Start date/time (ISO 8601)' },
            to: { type: 'string', description: 'End date/time (ISO 8601)' },
          },
          required: ['from', 'to'],
        },
      },
      {
        name: 'apple_calendar_search',
        description: 'Search calendar events by keyword.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            from: { type: 'string', description: 'Start date (ISO 8601, default: 1 year ago)' },
            to: { type: 'string', description: 'End date (ISO 8601, default: 1 year from now)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'apple_calendar_create',
        description: 'Create a new calendar event.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title' },
            start: { type: 'string', description: 'Start date/time (ISO 8601)' },
            end: { type: 'string', description: 'End date/time (ISO 8601)' },
            calendar: { type: 'string', description: 'Calendar name (default: default calendar)' },
            location: { type: 'string', description: 'Event location' },
            notes: { type: 'string', description: 'Event notes' },
            allDay: { type: 'boolean', description: 'All-day event' },
          },
          required: ['title', 'start', 'end'],
        },
      },
      {
        name: 'apple_calendar_update',
        description: 'Update an existing calendar event.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Event ID' },
            title: { type: 'string', description: 'New title' },
            start: { type: 'string', description: 'New start date/time (ISO 8601)' },
            end: { type: 'string', description: 'New end date/time (ISO 8601)' },
            calendar: { type: 'string', description: 'New calendar name' },
            location: { type: 'string', description: 'New location' },
            notes: { type: 'string', description: 'New notes' },
          },
          required: ['id'],
        },
      },
      {
        name: 'apple_calendar_delete',
        description: 'Delete a calendar event.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Event ID to delete' },
          },
          required: ['id'],
        },
      },
    ];
  }

  private assertSuccess(result: { success: boolean; [key: string]: unknown }): void {
    if (!result.success) {
      throw new Error((result as any).error ?? 'Unknown calendar error');
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/apple/src/__tests__/calendar-service.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Build package**

Run: `npm run build -w packages/apple`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add packages/apple/src/calendar-service.ts packages/apple/src/__tests__/calendar-service.test.ts packages/apple/src/index.ts
git commit -m "feat(apple): implement AppleCalendarService with tool definitions"
```

---

## Chunk 3: Config, MCP Server, Bootstrap Wiring

### Task 6: Update AppleConfig

**Files:**
- Modify: `packages/core/src/config/schema.ts`

- [ ] **Step 1: Update AppleConfig interface**

Replace the existing `AppleConfig` in `packages/core/src/config/schema.ts`:

```typescript
export interface AppleConfig {
  enabled: boolean;
  helper_path?: string;
  shortcuts_enabled?: boolean;
}
```

- [ ] **Step 2: Update DEFAULT_CONFIG**

Replace the `apple` section in `DEFAULT_CONFIG`:

```typescript
  apple: {
    enabled: false,
  },
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/schema.ts
git commit -m "feat(core): update AppleConfig with enabled and helper_path fields"
```

---

### Task 7: Add MCP server handler branches

**Files:**
- Modify: `packages/skills/src/mcp-server.ts`

- [ ] **Step 1: Add `--apple-helper` to parseArgs**

In `packages/skills/src/mcp-server.ts`, add to the `parseArgs` function:

Add `appleHelperPath: string;` to the return type.
Add `let appleHelperPath = '';` to the locals.
Add case in the switch:
```typescript
      case '--apple-helper':
        appleHelperPath = argv[++i] ?? '';
        break;
```
Add `appleHelperPath` to the return object.

- [ ] **Step 2: Add import and instantiation**

Add import at top of `packages/skills/src/mcp-server.ts`:
```typescript
import { SwiftBridge, AppleCalendarService } from '@ccbuddy/apple';
```

In `main()`, after the `retrievalTools` setup block, add:
```typescript
  // 1c. Optionally wire Apple calendar tools
  let calendarService: AppleCalendarService | null = null;
  if (args.appleHelperPath) {
    const bridge = new SwiftBridge(args.appleHelperPath);
    calendarService = new AppleCalendarService(bridge);
  }
```

- [ ] **Step 3: Add tool definitions to ListTools handler**

In the `ListToolsRequestSchema` handler, after the retrieval tools section, add:
```typescript
    // Calendar tools
    if (calendarService) {
      for (const tool of calendarService.getToolDefinitions()) {
        tools.push(tool);
      }
    }
```

- [ ] **Step 4: Add CallTool handler branches**

In the `CallToolRequestSchema` handler, before the `// ── Unknown tool` section, add:

```typescript
    // ── apple_calendar_list ────────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_list') {
      const result = await calendarService.listEvents(toolArgs.from as string, toolArgs.to as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, events: result }) }] };
    }

    // ── apple_calendar_search ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_search') {
      const result = await calendarService.searchEvents(
        toolArgs.query as string,
        toolArgs.from as string | undefined,
        toolArgs.to as string | undefined,
      );
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, events: result }) }] };
    }

    // ── apple_calendar_create ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_create') {
      const event = await calendarService.createEvent({
        title: toolArgs.title as string,
        start: toolArgs.start as string,
        end: toolArgs.end as string,
        calendar: toolArgs.calendar as string | undefined,
        location: toolArgs.location as string | undefined,
        notes: toolArgs.notes as string | undefined,
        allDay: toolArgs.allDay as boolean | undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, event }) }] };
    }

    // ── apple_calendar_update ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_update') {
      const event = await calendarService.updateEvent(toolArgs.id as string, {
        title: toolArgs.title as string | undefined,
        start: toolArgs.start as string | undefined,
        end: toolArgs.end as string | undefined,
        calendar: toolArgs.calendar as string | undefined,
        location: toolArgs.location as string | undefined,
        notes: toolArgs.notes as string | undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, event }) }] };
    }

    // ── apple_calendar_delete ──────────────────────────────────────────────
    if (calendarService && name === 'apple_calendar_delete') {
      await calendarService.deleteEvent(toolArgs.id as string);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    }
```

- [ ] **Step 5: Add @ccbuddy/apple dependency to @ccbuddy/skills**

Add to `packages/skills/package.json` dependencies:
```json
"@ccbuddy/apple": "*"
```

Add to `packages/skills/tsconfig.json` references:
```json
{ "path": "../apple" }
```

Run: `npm install`

- [ ] **Step 6: Build to verify**

Run: `npm run build -w packages/apple && npm run build -w packages/skills`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
git add packages/skills/src/mcp-server.ts packages/skills/package.json packages/skills/tsconfig.json
git commit -m "feat(skills): add Apple Calendar tool handlers to MCP server"
```

---

### Task 8: Wire into bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Add import**

Add to imports in `packages/main/src/bootstrap.ts`:
```typescript
import { SwiftBridge, AppleCalendarService } from '@ccbuddy/apple';
```

- [ ] **Step 2: Add helper path to MCP server args**

After the `skillMcpServer` object creation, before the `skillNudge` line, add:

```typescript
  // 7b. Wire Apple Calendar if enabled
  if (config.apple.enabled) {
    const helperPath = config.apple.helper_path
      ?? join(resolvedConfigDir, 'swift-helper', '.build', 'release', 'ccbuddy-helper');
    skillMcpServer.args.push('--apple-helper', helperPath);
  }
```

- [ ] **Step 3: Add @ccbuddy/apple dependency to @ccbuddy/main**

Add to `packages/main/package.json` dependencies:
```json
"@ccbuddy/apple": "*"
```

Add to `packages/main/tsconfig.json` references:
```json
{ "path": "../apple" }
```

Run: `npm install`

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/bootstrap.ts packages/main/package.json packages/main/tsconfig.json
git commit -m "feat(main): wire Apple Calendar into bootstrap via MCP server args"
```

---

### Task 9: Enable in local config and smoke test

- [ ] **Step 1: Enable Apple in local.yaml**

Add to `config/local.yaml` under `ccbuddy:`:

```yaml
  apple:
    enabled: true
```

- [ ] **Step 2: Build Swift helper**

Run: `cd swift-helper && swift build -c release`
Expected: Binary at `swift-helper/.build/release/ccbuddy-helper`

- [ ] **Step 3: Restart CCBuddy and test via Discord**

Test messages:
- "What's on my calendar today?"
- "Create an event called 'Test Event' tomorrow at 3pm to 4pm"
- "Search my calendar for 'Test Event'"
- "Delete the Test Event"

- [ ] **Step 4: Verify morning briefing uses calendar**

Wait for next morning briefing, or manually test by checking the briefing prompt references calendar skills.

- [ ] **Step 5: Commit config change**

```bash
# local.yaml is gitignored — no commit needed
```
