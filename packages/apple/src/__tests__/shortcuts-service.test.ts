import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { AppleShortcutsService } from '../shortcuts-service.js';

describe('AppleShortcutsService', () => {
  let service: AppleShortcutsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AppleShortcutsService();
  });

  describe('listShortcuts()', () => {
    it('parses shortcut names from stdout', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Turn Off Lights\nMorning Routine\nDo Not Disturb\n', '');
      });

      const result = await service.listShortcuts();
      expect(result).toEqual([
        { name: 'Turn Off Lights' },
        { name: 'Morning Routine' },
        { name: 'Do Not Disturb' },
      ]);
      expect(mockExecFile).toHaveBeenCalledWith(
        'shortcuts', ['list'], expect.any(Object), expect.any(Function),
      );
    });

    it('returns empty array when no shortcuts', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '', '');
      });

      const result = await service.listShortcuts();
      expect(result).toEqual([]);
    });
  });

  describe('runShortcut()', () => {
    it('runs shortcut by name', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Lights turned off', '');
      });

      const result = await service.runShortcut('Turn Off Lights');
      expect(result).toEqual({ output: 'Lights turned off' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'shortcuts', ['run', 'Turn Off Lights'], expect.any(Object), expect.any(Function),
      );
    });

    it('passes input when provided', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Done', '');
      });

      await service.runShortcut('Process Text', 'hello world');
      expect(mockExecFile).toHaveBeenCalledWith(
        'shortcuts', ['run', 'Process Text', '-i', 'hello world'], expect.any(Object), expect.any(Function),
      );
    });

    it('throws on error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('not found'), '', 'Shortcut not found');
      });

      await expect(service.runShortcut('Nonexistent')).rejects.toThrow('Shortcuts command failed');
    });
  });

  describe('getToolDefinitions()', () => {
    it('returns 2 tool definitions', () => {
      const tools = service.getToolDefinitions();
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name)).toEqual(['apple_shortcuts_list', 'apple_shortcuts_run']);
    });
  });
});
