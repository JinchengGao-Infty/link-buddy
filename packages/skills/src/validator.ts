import type { SkillPermission } from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Maps dangerous module names to the SkillPermission required to use them.
 * A null value means the module is always allowed.
 */
const MODULE_PERMISSION_MAP: Record<string, SkillPermission | null> = {
  'child_process': 'shell',
  'node:child_process': 'shell',
  'fs': 'filesystem',
  'node:fs': 'filesystem',
  'fs/promises': 'filesystem',
  'node:fs/promises': 'filesystem',
  'http': 'network',
  'node:http': 'network',
  'https': 'network',
  'node:https': 'network',
  'net': 'network',
  'node:net': 'network',
  'path': null,
  'node:path': null,
};

/**
 * SkillValidator performs static analysis on skill code to detect dangerous
 * patterns. Permissions can be granted to allow specific restricted operations.
 */
export class SkillValidator {
  /**
   * Validate skill source code against a set of granted permissions.
   *
   * @param code - The TypeScript/JavaScript source code to validate
   * @param grantedPermissions - Optional list of permissions that are allowed
   * @returns A ValidationResult with valid flag, errors, and warnings
   */
  validate(code: string, grantedPermissions: SkillPermission[] = []): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const granted = new Set(grantedPermissions);

    // ── 1. Must have `export default (async) function` ─────────────────────
    const hasDefaultExport = /export\s+default\s+async\s+function|export\s+default\s+function/.test(code);
    if (!hasDefaultExport) {
      errors.push('Skill must have "export default async function" as its entry point');
    }

    // ── 2. Check ES module imports: import ... from 'module' ───────────────
    const importFromPattern = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
    let importMatch: RegExpExecArray | null;
    while ((importMatch = importFromPattern.exec(code)) !== null) {
      const moduleName = importMatch[1];
      this._checkModule(moduleName, granted, errors);
    }

    // ── 3. Check CommonJS require('module') ────────────────────────────────
    const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let requireMatch: RegExpExecArray | null;
    while ((requireMatch = requirePattern.exec(code)) !== null) {
      const moduleName = requireMatch[1];
      this._checkModule(moduleName, granted, errors);
    }

    // ── 4. Check dangerous global patterns ────────────────────────────────
    // eval()
    if (/\beval\s*\(/.test(code)) {
      errors.push('Use of eval() is not permitted in skills');
    }

    // new Function()
    if (/\bnew\s+Function\s*\(/.test(code)) {
      errors.push('Use of new Function() is not permitted in skills');
    }

    // process.env
    if (/\bprocess\.env\b/.test(code)) {
      errors.push('Access to process.env is not permitted in skills');
    }

    // process.exit
    if (/\bprocess\.exit\s*\(/.test(code)) {
      errors.push('Use of process.exit() is not permitted in skills');
    }

    // ── 5. Check fetch() — requires network permission ─────────────────────
    if (/\bfetch\s*\(/.test(code)) {
      if (!granted.has('network')) {
        errors.push('Use of fetch() requires the "network" permission');
      }
    }

    // ── 6. Warn about dynamic imports (known limitation) ───────────────────
    if (/\bimport\s*\(/.test(code)) {
      warnings.push(
        'Dynamic import() detected. Static analysis cannot verify the target module — ' +
        'ensure no dangerous modules are loaded at runtime.'
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private _checkModule(
    moduleName: string,
    granted: Set<SkillPermission>,
    errors: string[],
  ): void {
    if (!(moduleName in MODULE_PERMISSION_MAP)) {
      // Unknown module — not in our deny-list, allow it
      return;
    }

    const requiredPermission = MODULE_PERMISSION_MAP[moduleName];

    // null means always allowed (e.g. path)
    if (requiredPermission === null) {
      return;
    }

    if (!granted.has(requiredPermission)) {
      errors.push(
        `Import of "${moduleName}" requires the "${requiredPermission}" permission`
      );
    }
  }
}
