import { writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { SkillInputSchema, SkillPermission } from './types.js';
import type { SkillRegistry } from './registry.js';
import type { SkillValidator } from './validator.js';

// ── Public interfaces ──────────────────────────────────────────────────────

export interface CreateSkillRequest {
  name: string;
  description: string;
  code: string;
  inputSchema: SkillInputSchema;
  permissions?: SkillPermission[];
  createdBy: string;
  createdByRole: 'admin' | 'chat' | 'system';
}

export interface UpdateSkillRequest {
  description?: string;
  code?: string;
  inputSchema?: SkillInputSchema;
  permissions?: SkillPermission[];
}

export interface GeneratorResult {
  success: boolean;
  errors?: string[];
  filePath?: string;
}

// ── Name validation regex ──────────────────────────────────────────────────

const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// ── SkillGenerator ─────────────────────────────────────────────────────────

/**
 * SkillGenerator creates and updates skill files on disk, validates them
 * before registration, and loads bundled skills from the bundled/ directory.
 */
export class SkillGenerator {
  /**
   * Optional hook called before a skill is registered.
   * Intended for CC code review — return `{ approved: false, reason }` to abort.
   */
  onBeforeRegister?: (name: string, code: string) => Promise<{ approved: boolean; reason?: string }>;

  /**
   * Optional hook called after a skill file is saved.
   * Intended for git commit integration.
   */
  onAfterSave?: (filePath: string, skillName: string) => Promise<void>;

  constructor(
    private readonly registry: SkillRegistry,
    private readonly validator: SkillValidator,
    private readonly skillsDir: string,
  ) {}

  // ── createSkill ──────────────────────────────────────────────────────────

  async createSkill(request: CreateSkillRequest): Promise<GeneratorResult> {
    const { name, description, code, inputSchema, permissions = [], createdBy, createdByRole } = request;

    // 1. Reject chat users
    if (createdByRole === 'chat') {
      return {
        success: false,
        errors: ['Skill creation by chat users is not permitted'],
      };
    }

    // 2. Validate name
    if (!name || !VALID_NAME_RE.test(name)) {
      return {
        success: false,
        errors: [
          `Invalid skill name "${name}". Name must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alphanumeric and hyphens only, must start with alphanumeric)`,
        ],
      };
    }

    // 3. Validate code
    const validation = this.validator.validate(code, permissions);
    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors,
      };
    }

    // 4. Optional pre-register hook
    if (this.onBeforeRegister) {
      const approval = await this.onBeforeRegister(name, code);
      if (!approval.approved) {
        return {
          success: false,
          errors: [approval.reason ?? 'Skill was rejected by pre-register hook'],
        };
      }
    }

    // 5. Write to disk
    const filePath = join(this.skillsDir, 'generated', `${name}.mjs`);
    writeFileSync(filePath, code, 'utf8');

    // 6. Register with metadata
    const now = new Date().toISOString();
    this.registry.register(
      {
        name,
        description,
        version: '1.0.0',
        source: 'generated',
        filePath,
        inputSchema,
        permissions,
        enabled: true,
      },
      {
        createdBy,
        createdAt: now,
        updatedAt: now,
        usageCount: 0,
      },
    );

    // 7. Save registry
    await this.registry.save();

    // 8. Optional post-save hook
    if (this.onAfterSave) {
      await this.onAfterSave(filePath, name);
    }

    return { success: true, filePath };
  }

  // ── updateSkill ──────────────────────────────────────────────────────────

  async updateSkill(name: string, updates: UpdateSkillRequest): Promise<GeneratorResult> {
    // 1. Get existing from registry
    const existing = this.registry.get(name);
    if (!existing) {
      return {
        success: false,
        errors: [`Skill "${name}" not found in registry`],
      };
    }

    const { definition } = existing;
    let { code: newCode, description, inputSchema, permissions } = updates;

    // 2. If new code provided, validate it
    if (newCode !== undefined) {
      const grantedPermissions = permissions ?? definition.permissions;
      const validation = this.validator.validate(newCode, grantedPermissions);
      if (!validation.valid) {
        return {
          success: false,
          errors: validation.errors,
        };
      }

      // Optional pre-register hook
      if (this.onBeforeRegister) {
        const approval = await this.onBeforeRegister(name, newCode);
        if (!approval.approved) {
          return {
            success: false,
            errors: [approval.reason ?? 'Updated skill was rejected by pre-register hook'],
          };
        }
      }

      // 3. Write updated code to existing filePath
      writeFileSync(definition.filePath, newCode, 'utf8');
    }

    // 4. Update registry entry
    const updatedDefinition = {
      ...definition,
      description: description ?? definition.description,
      inputSchema: inputSchema ?? definition.inputSchema,
      permissions: permissions ?? definition.permissions,
    };
    this.registry.update(name, updatedDefinition);

    // 5. Save
    await this.registry.save();

    // Optional post-save hook
    if (this.onAfterSave) {
      await this.onAfterSave(definition.filePath, name);
    }

    return { success: true, filePath: definition.filePath };
  }

  // ── loadBundledSkills ────────────────────────────────────────────────────

  /**
   * Scans `{skillsDir}/bundled/` for `.mjs`/`.js` files, reads companion
   * `.json` metadata, and registers each skill with source='bundled'.
   *
   * @returns The number of bundled skills successfully loaded.
   */
  async loadBundledSkills(): Promise<number> {
    const bundledDir = join(this.skillsDir, 'bundled');

    if (!existsSync(bundledDir)) {
      return 0;
    }

    const entries = readdirSync(bundledDir);
    const skillFiles = entries.filter(f => f.endsWith('.mjs') || f.endsWith('.js'));

    let count = 0;

    for (const file of skillFiles) {
      const filePath = join(bundledDir, file);
      const nameWithoutExt = basename(file, file.endsWith('.mjs') ? '.mjs' : '.js');
      const metaPath = join(bundledDir, `${nameWithoutExt}.json`);

      // Read companion JSON metadata
      if (!existsSync(metaPath)) {
        // No metadata — skip
        continue;
      }

      let meta: {
        name?: string;
        description?: string;
        version?: string;
        inputSchema?: SkillInputSchema;
        permissions?: SkillPermission[];
      };

      try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {
        // Malformed JSON — skip
        continue;
      }

      const skillName = meta.name ?? nameWithoutExt;

      // Skip if already registered (idempotent)
      if (this.registry.get(skillName)) {
        count++;
        continue;
      }

      const now = new Date().toISOString();
      this.registry.register(
        {
          name: skillName,
          description: meta.description ?? '',
          version: meta.version ?? '1.0.0',
          source: 'bundled',
          filePath,
          inputSchema: meta.inputSchema ?? { type: 'object', properties: {} },
          permissions: meta.permissions ?? [],
          enabled: true,
        },
        {
          createdBy: 'system',
          createdAt: now,
          updatedAt: now,
          usageCount: 0,
        },
      );

      count++;
    }

    await this.registry.save();
    return count;
  }
}
