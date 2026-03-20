import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppleRemindersService } from '../reminders-service.js';
import type { SwiftBridge } from '../swift-bridge.js';

function createMockBridge(): SwiftBridge & { exec: ReturnType<typeof vi.fn> } {
  return { exec: vi.fn() } as any;
}

const sampleReminder = {
  id: 'rem1',
  title: 'Buy milk',
  isCompleted: false,
  dueDate: null,
  list: 'Reminders',
  notes: '',
  priority: 0,
};

describe('AppleRemindersService', () => {
  let bridge: ReturnType<typeof createMockBridge>;
  let service: AppleRemindersService;

  beforeEach(() => {
    bridge = createMockBridge();
    service = new AppleRemindersService(bridge);
  });

  describe('listReminders()', () => {
    it('calls bridge with reminders list args (no options)', async () => {
      bridge.exec.mockResolvedValue({ success: true, reminders: [] });

      const result = await service.listReminders();

      expect(bridge.exec).toHaveBeenCalledWith(['reminders', 'list']);
      expect(result).toEqual([]);
    });

    it('passes --list when list name provided', async () => {
      bridge.exec.mockResolvedValue({ success: true, reminders: [sampleReminder] });

      const result = await service.listReminders('Shopping');

      expect(bridge.exec).toHaveBeenCalledWith(['reminders', 'list', '--list', 'Shopping']);
      expect(result).toHaveLength(1);
    });

    it('passes --show-completed flag when showCompleted is true', async () => {
      bridge.exec.mockResolvedValue({ success: true, reminders: [] });

      await service.listReminders(undefined, true);

      expect(bridge.exec).toHaveBeenCalledWith(['reminders', 'list', '--show-completed']);
    });

    it('passes both --list and --show-completed when both provided', async () => {
      bridge.exec.mockResolvedValue({ success: true, reminders: [] });

      await service.listReminders('Work', true);

      expect(bridge.exec).toHaveBeenCalledWith([
        'reminders', 'list', '--list', 'Work', '--show-completed',
      ]);
    });
  });

  describe('createReminder()', () => {
    it('calls bridge with required title arg', async () => {
      bridge.exec.mockResolvedValue({ success: true, reminder: sampleReminder });

      const result = await service.createReminder({ title: 'Buy milk' });

      expect(bridge.exec).toHaveBeenCalledWith(['reminders', 'create', '--title', 'Buy milk']);
      expect(result.id).toBe('rem1');
    });

    it('includes optional fields when provided', async () => {
      bridge.exec.mockResolvedValue({ success: true, reminder: sampleReminder });

      await service.createReminder({
        title: 'Doctor appointment',
        due: '2026-04-01T10:00:00Z',
        list: 'Health',
        notes: 'Bring insurance card',
        priority: 1,
      });

      const args = bridge.exec.mock.calls[0][0] as string[];
      expect(args).toContain('--due');
      expect(args).toContain('2026-04-01T10:00:00Z');
      expect(args).toContain('--list');
      expect(args).toContain('Health');
      expect(args).toContain('--notes');
      expect(args).toContain('Bring insurance card');
      expect(args).toContain('--priority');
      expect(args).toContain('1');
    });

    it('throws when bridge returns error', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'List not found' });

      await expect(service.createReminder({ title: 'Test' })).rejects.toThrow('List not found');
    });
  });

  describe('completeReminder()', () => {
    it('calls bridge with complete args', async () => {
      bridge.exec.mockResolvedValue({ success: true, reminder: { ...sampleReminder, isCompleted: true } });

      const result = await service.completeReminder('rem1');

      expect(bridge.exec).toHaveBeenCalledWith(['reminders', 'complete', '--id', 'rem1']);
      expect(result.isCompleted).toBe(true);
    });

    it('throws when bridge returns error', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'Reminder not found' });

      await expect(service.completeReminder('bad')).rejects.toThrow('Reminder not found');
    });
  });

  describe('deleteReminder()', () => {
    it('calls bridge with delete args', async () => {
      bridge.exec.mockResolvedValue({ success: true });

      await service.deleteReminder('rem1');

      expect(bridge.exec).toHaveBeenCalledWith(['reminders', 'delete', '--id', 'rem1']);
    });

    it('throws when bridge returns error', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'Reminder not found' });

      await expect(service.deleteReminder('bad')).rejects.toThrow('Reminder not found');
    });
  });

  describe('getToolDefinitions()', () => {
    it('returns 4 tool definitions', () => {
      const tools = service.getToolDefinitions();
      expect(tools).toHaveLength(4);
      const names = tools.map(t => t.name);
      expect(names).toContain('apple_reminders_list');
      expect(names).toContain('apple_reminders_create');
      expect(names).toContain('apple_reminders_complete');
      expect(names).toContain('apple_reminders_delete');
    });
  });
});
