import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../registry.js';
import { SkillValidator } from '../validator.js';
import { SkillGenerator } from '../generator.js';
import type { CreateSkillRequest, UpdateSkillRequest } from '../generator.js';

// ── helpers ────────────────────────────────────────────────────────────────

const VALID_SKILL_CODE = `export default async function (input) {
  return { success: true, result: input.value };
}`;

const INVALID_SKILL_CODE = `import { exec } from 'child_process';
export default async function (input) {
  exec('ls');
  return { success: true };
}`;

const VALID_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    value: { type: 'string', description: 'The value to process' },
  },
};

// ── test setup ─────────────────────────────────────────────────────────────

let tmpDir: string;
let registry: SkillRegistry;
let validator: SkillValidator;
let generator: SkillGenerator;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skill-generator-'));
  mkdirSync(join(tmpDir, 'generated'), { recursive: true });
  mkdirSync(join(tmpDir, 'bundled'), { recursive: true });
  mkdirSync(join(tmpDir, 'user'), { recursive: true });

  const registryPath = join(tmpDir, 'registry.yaml');
  registry = new SkillRegistry(registryPath);
  await registry.load();

  validator = new SkillValidator();
  generator = new SkillGenerator(registry, validator, tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('SkillGenerator', () => {
  describe('createSkill', () => {
    it('creates a skill .mjs file and registers it', async () => {
      const request: CreateSkillRequest = {
        name: 'my-skill',
        description: 'A test skill',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);

      expect(result.success).toBe(true);
      expect(result.filePath).toBeDefined();
      expect(result.errors).toBeUndefined();

      // File should exist on disk
      const expectedPath = join(tmpDir, 'generated', 'my-skill.mjs');
      expect(existsSync(expectedPath)).toBe(true);
      expect(readFileSync(expectedPath, 'utf8')).toBe(VALID_SKILL_CODE);

      // Should be registered
      const skill = registry.get('my-skill');
      expect(skill).toBeDefined();
      expect(skill?.definition.name).toBe('my-skill');
      expect(skill?.definition.source).toBe('generated');
      expect(skill?.definition.filePath).toBe(expectedPath);
      expect(skill?.metadata.createdBy).toBe('admin-user');
    });

    it('rejects invalid code (child_process import)', async () => {
      const request: CreateSkillRequest = {
        name: 'bad-skill',
        description: 'A dangerous skill',
        code: INVALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin-user',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.filePath).toBeUndefined();

      // File should NOT be created
      const expectedPath = join(tmpDir, 'generated', 'bad-skill.mjs');
      expect(existsSync(expectedPath)).toBe(false);

      // Should NOT be registered
      expect(registry.get('bad-skill')).toBeUndefined();
    });

    it('rejects skill creation from chat users (createdByRole: chat)', async () => {
      const request: CreateSkillRequest = {
        name: 'chat-skill',
        description: 'Created by chat user',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'some-user',
        createdByRole: 'chat',
      };

      const result = await generator.createSkill(request);

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(e => e.toLowerCase().includes('chat'))).toBe(true);
      expect(existsSync(join(tmpDir, 'generated', 'chat-skill.mjs'))).toBe(false);
    });

    it('rejects invalid skill names - path traversal', async () => {
      const request: CreateSkillRequest = {
        name: '../escape',
        description: 'Path traversal attempt',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('rejects invalid skill names - uppercase letters', async () => {
      const request: CreateSkillRequest = {
        name: 'MySkill',
        description: 'Has uppercase',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('rejects invalid skill names - spaces', async () => {
      const request: CreateSkillRequest = {
        name: 'my skill',
        description: 'Has spaces',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('rejects invalid skill names - empty string', async () => {
      const request: CreateSkillRequest = {
        name: '',
        description: 'Empty name',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };

      const result = await generator.createSkill(request);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe('updateSkill', () => {
    it('updates an existing skill — new code written, description updated', async () => {
      // First create the skill
      const createRequest: CreateSkillRequest = {
        name: 'update-me',
        description: 'Original description',
        code: VALID_SKILL_CODE,
        inputSchema: VALID_INPUT_SCHEMA,
        createdBy: 'admin',
        createdByRole: 'admin',
      };
      await generator.createSkill(createRequest);

      const newCode = `export default async function (input) {
  return { success: true, result: 'updated: ' + input.value };
}`;

      const updates: UpdateSkillRequest = {
        description: 'Updated description',
        code: newCode,
      };

      const result = await generator.updateSkill('update-me', updates);

      expect(result.success).toBe(true);

      // File should have new code
      const filePath = join(tmpDir, 'generated', 'update-me.mjs');
      expect(readFileSync(filePath, 'utf8')).toBe(newCode);

      // Registry should have updated description
      const skill = registry.get('update-me');
      expect(skill?.definition.description).toBe('Updated description');
    });
  });

  describe('loadBundledSkills', () => {
    it('loads bundled skills from bundled/ directory with companion .json metadata', async () => {
      // Create a bundled skill with companion json
      const bundledCode = `export default async function (input) {
  const name = input.name ?? 'World';
  return { success: true, result: \`Hello, \${name}!\` };
}`;
      writeFileSync(join(tmpDir, 'bundled', 'hello-world.mjs'), bundledCode, 'utf8');
      writeFileSync(
        join(tmpDir, 'bundled', 'hello-world.json'),
        JSON.stringify({
          name: 'hello-world',
          description: 'A simple greeting skill',
          version: '1.0.0',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name to greet' },
            },
          },
          permissions: [],
        }),
        'utf8',
      );

      const count = await generator.loadBundledSkills();

      expect(count).toBe(1);

      const skill = registry.get('hello-world');
      expect(skill).toBeDefined();
      expect(skill?.definition.source).toBe('bundled');
      expect(skill?.definition.description).toBe('A simple greeting skill');
    });
  });
});
