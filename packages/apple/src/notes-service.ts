import type { JxaBridge } from './jxa-bridge.js';
import type { ToolDescription } from '@ccbuddy/core';

export interface Note {
  id: string;
  name: string;
  body: string;
  folder: string;
  creationDate: string;
  modificationDate: string;
}

export interface CreateNoteParams {
  title: string;
  body?: string;
  folder?: string;
}

const SEARCH_TEMPLATE = `(() => {
  const Notes = Application("Notes");
  const query = "<QUERY>";
  const results = Notes.notes().filter(n => {
    const name = n.name();
    const body = n.plaintext();
    return name.toLowerCase().includes(query.toLowerCase()) || body.toLowerCase().includes(query.toLowerCase());
  }).slice(0, 20);
  const notes = results.map(n => ({
    id: n.id(),
    name: n.name(),
    body: n.plaintext().substring(0, 500),
    folder: n.container().name(),
    creationDate: n.creationDate().toISOString(),
    modificationDate: n.modificationDate().toISOString()
  }));
  return JSON.stringify({ success: true, notes: notes });
})()`;

const READ_TEMPLATE = `(() => {
  const Notes = Application("Notes");
  const matches = Notes.notes.whose({ name: "<NAME>" })();
  if (matches.length === 0) return JSON.stringify({ success: false, error: "Note not found" });
  const n = matches[0];
  return JSON.stringify({ success: true, note: {
    id: n.id(),
    name: n.name(),
    body: n.plaintext(),
    folder: n.container().name(),
    creationDate: n.creationDate().toISOString(),
    modificationDate: n.modificationDate().toISOString()
  }});
})()`;

const CREATE_TEMPLATE = `(() => {
  const Notes = Application("Notes");
  const folder = "<FOLDER>";
  const target = folder ? Notes.folders.byName(folder) : Notes.defaultAccount().defaultFolder;
  const n = Notes.Note({ name: "<TITLE>", body: "<BODY>" });
  target.notes.push(n);
  return JSON.stringify({ success: true, note: {
    id: n.id(),
    name: n.name(),
    body: n.plaintext().substring(0, 500),
    folder: n.container().name(),
    creationDate: n.creationDate().toISOString(),
    modificationDate: n.modificationDate().toISOString()
  }});
})()`;

export class AppleNotesService {
  private readonly bridge: JxaBridge;

  constructor(bridge: JxaBridge) {
    this.bridge = bridge;
  }

  async searchNotes(query: string): Promise<Note[]> {
    const script = this.buildScript(SEARCH_TEMPLATE, { QUERY: query });
    const result = await this.bridge.exec(script);
    if (!result.success) {
      throw new Error((result as any).error ?? 'Unknown notes error');
    }
    return (result as any).notes ?? [];
  }

  async readNote(name: string): Promise<Note> {
    const script = this.buildScript(READ_TEMPLATE, { NAME: name });
    const result = await this.bridge.exec(script);
    if (!result.success) {
      throw new Error((result as any).error ?? 'Note not found');
    }
    return (result as any).note;
  }

  async createNote(params: CreateNoteParams): Promise<Note> {
    const script = this.buildScript(CREATE_TEMPLATE, {
      FOLDER: params.folder ?? '',
      TITLE: params.title,
      BODY: params.body ?? '',
    });
    const result = await this.bridge.exec(script);
    if (!result.success) {
      throw new Error((result as any).error ?? 'Failed to create note');
    }
    return (result as any).note;
  }

  getToolDefinitions(): ToolDescription[] {
    return [
      {
        name: 'apple_notes_search',
        description: 'Search Apple Notes by title or body content.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query to match against note titles and content' },
          },
          required: ['query'],
        },
      },
      {
        name: 'apple_notes_read',
        description: 'Read an Apple Note by exact name/title.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact name/title of the note to read' },
          },
          required: ['name'],
        },
      },
      {
        name: 'apple_notes_create',
        description: 'Create a new Apple Note.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Note title' },
            body: { type: 'string', description: 'Note body content (optional)' },
            folder: { type: 'string', description: 'Folder name to create the note in (default: default folder)' },
          },
          required: ['title'],
        },
      },
    ];
  }

  private buildScript(template: string, vars: Record<string, string>): string {
    let script = template;
    for (const [key, value] of Object.entries(vars)) {
      // Escape for JavaScript string literal
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      script = script.replace(`<${key}>`, escaped);
    }
    return script;
  }
}
