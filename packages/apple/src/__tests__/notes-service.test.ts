import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppleNotesService } from '../notes-service.js';
import type { JxaBridge } from '../jxa-bridge.js';

function createMockBridge(): JxaBridge & { exec: ReturnType<typeof vi.fn> } {
  return { exec: vi.fn() } as any;
}

const sampleNote = {
  id: 'note-1',
  name: 'Test Note',
  body: 'Some body content',
  folder: 'Notes',
  creationDate: '2026-01-01T00:00:00.000Z',
  modificationDate: '2026-01-02T00:00:00.000Z',
};

describe('AppleNotesService', () => {
  let bridge: ReturnType<typeof createMockBridge>;
  let service: AppleNotesService;

  beforeEach(() => {
    bridge = createMockBridge();
    service = new AppleNotesService(bridge);
  });

  describe('searchNotes()', () => {
    it('calls bridge.exec with a script containing the query', async () => {
      bridge.exec.mockResolvedValue({ success: true, notes: [sampleNote] });

      const result = await service.searchNotes('dentist');

      expect(bridge.exec).toHaveBeenCalledOnce();
      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('"dentist"');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Note');
    });

    it('returns empty array when no results', async () => {
      bridge.exec.mockResolvedValue({ success: true, notes: [] });

      const result = await service.searchNotes('nothing');
      expect(result).toEqual([]);
    });

    it('throws when bridge returns failure', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'Notes app error' });

      await expect(service.searchNotes('query')).rejects.toThrow('Notes app error');
    });

    it('escapes special characters in query', async () => {
      bridge.exec.mockResolvedValue({ success: true, notes: [] });

      await service.searchNotes('say "hello"');

      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('\\"hello\\"');
    });
  });

  describe('readNote()', () => {
    it('calls bridge.exec with a script containing the note name', async () => {
      bridge.exec.mockResolvedValue({ success: true, note: sampleNote });

      const result = await service.readNote('Test Note');

      expect(bridge.exec).toHaveBeenCalledOnce();
      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('"Test Note"');
      expect(result.id).toBe('note-1');
    });

    it('throws when note is not found', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'Note not found' });

      await expect(service.readNote('Nonexistent')).rejects.toThrow('Note not found');
    });

    it('escapes special characters in note name', async () => {
      bridge.exec.mockResolvedValue({ success: true, note: sampleNote });

      await service.readNote('My "special" note');

      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('\\"special\\"');
    });
  });

  describe('createNote()', () => {
    it('calls bridge.exec with a script containing title and body', async () => {
      bridge.exec.mockResolvedValue({ success: true, note: sampleNote });

      const result = await service.createNote({ title: 'New Note', body: 'Hello world' });

      expect(bridge.exec).toHaveBeenCalledOnce();
      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('"New Note"');
      expect(script).toContain('"Hello world"');
      expect(result.id).toBe('note-1');
    });

    it('includes folder name when provided', async () => {
      bridge.exec.mockResolvedValue({ success: true, note: sampleNote });

      await service.createNote({ title: 'Foldered Note', folder: 'Work' });

      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('"Work"');
    });

    it('uses empty string for missing optional fields', async () => {
      bridge.exec.mockResolvedValue({ success: true, note: sampleNote });

      await service.createNote({ title: 'Minimal Note' });

      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('"Minimal Note"');
    });

    it('throws when bridge returns failure', async () => {
      bridge.exec.mockResolvedValue({ success: false, error: 'Folder not found' });

      await expect(service.createNote({ title: 'Broken', folder: 'BadFolder' })).rejects.toThrow('Folder not found');
    });

    it('escapes newlines in body', async () => {
      bridge.exec.mockResolvedValue({ success: true, note: sampleNote });

      await service.createNote({ title: 'Multi', body: 'Line 1\nLine 2' });

      const script = bridge.exec.mock.calls[0][0] as string;
      expect(script).toContain('Line 1\\nLine 2');
    });
  });

  describe('getToolDefinitions()', () => {
    it('returns 3 tool definitions', () => {
      const tools = service.getToolDefinitions();
      expect(tools).toHaveLength(3);
      const names = tools.map(t => t.name);
      expect(names).toContain('apple_notes_search');
      expect(names).toContain('apple_notes_read');
      expect(names).toContain('apple_notes_create');
    });

    it('apple_notes_search requires query', () => {
      const tools = service.getToolDefinitions();
      const searchTool = tools.find(t => t.name === 'apple_notes_search')!;
      expect(searchTool.inputSchema.required).toContain('query');
    });

    it('apple_notes_read requires name', () => {
      const tools = service.getToolDefinitions();
      const readTool = tools.find(t => t.name === 'apple_notes_read')!;
      expect(readTool.inputSchema.required).toContain('name');
    });

    it('apple_notes_create requires title', () => {
      const tools = service.getToolDefinitions();
      const createTool = tools.find(t => t.name === 'apple_notes_create')!;
      expect(createTool.inputSchema.required).toContain('title');
    });
  });
});
