import type { SwiftBridge } from './swift-bridge.js';
import type { ToolDescription } from '@ccbuddy/core';

export interface Reminder {
  id: string;
  title: string;
  isCompleted: boolean;
  dueDate: string | null;
  list: string;
  notes: string;
  priority: number;
}

export interface CreateReminderParams {
  title: string;
  due?: string;
  list?: string;
  notes?: string;
  priority?: number;
}

export class AppleRemindersService {
  private readonly bridge: SwiftBridge;

  constructor(bridge: SwiftBridge) {
    this.bridge = bridge;
  }

  async listReminders(list?: string, showCompleted?: boolean): Promise<Reminder[]> {
    const args = ['reminders', 'list'];
    if (list) args.push('--list', list);
    if (showCompleted) args.push('--show-completed');
    const result = await this.bridge.exec(args);
    return (result as any).reminders ?? [];
  }

  async createReminder(params: CreateReminderParams): Promise<Reminder> {
    const args = ['reminders', 'create', '--title', params.title];
    if (params.due) args.push('--due', params.due);
    if (params.list) args.push('--list', params.list);
    if (params.notes) args.push('--notes', params.notes);
    if (params.priority !== undefined) args.push('--priority', String(params.priority));

    const result = await this.bridge.exec(args);
    this.assertSuccess(result);
    return (result as any).reminder;
  }

  async completeReminder(id: string): Promise<Reminder> {
    const result = await this.bridge.exec(['reminders', 'complete', '--id', id]);
    this.assertSuccess(result);
    return (result as any).reminder;
  }

  async deleteReminder(id: string): Promise<void> {
    const result = await this.bridge.exec(['reminders', 'delete', '--id', id]);
    this.assertSuccess(result);
  }

  getToolDefinitions(): ToolDescription[] {
    return [
      {
        name: 'apple_reminders_list',
        description: 'List reminders from a specific list or all lists.',
        inputSchema: {
          type: 'object',
          properties: {
            list: { type: 'string', description: 'Reminder list name (default: all lists)' },
            showCompleted: { type: 'boolean', description: 'Include completed reminders (default: false)' },
          },
        },
      },
      {
        name: 'apple_reminders_create',
        description: 'Create a new reminder.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Reminder title' },
            due: { type: 'string', description: 'Due date/time (ISO 8601)' },
            list: { type: 'string', description: 'Reminder list name (default: default list)' },
            notes: { type: 'string', description: 'Notes' },
            priority: { type: 'number', description: 'Priority (0=none, 1=high, 5=medium, 9=low)' },
          },
          required: ['title'],
        },
      },
      {
        name: 'apple_reminders_complete',
        description: 'Mark a reminder as completed.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Reminder ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'apple_reminders_delete',
        description: 'Delete a reminder.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Reminder ID to delete' },
          },
          required: ['id'],
        },
      },
    ];
  }

  private assertSuccess(result: { success: boolean; [key: string]: unknown }): void {
    if (!result.success) {
      throw new Error((result as any).error ?? 'Unknown reminders error');
    }
  }
}
