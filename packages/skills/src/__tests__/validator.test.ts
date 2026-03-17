import { describe, it, expect } from 'vitest';
import { SkillValidator, type ValidationResult } from '../validator.js';

describe('SkillValidator', () => {
  const validator = new SkillValidator();

  // Test 1: Accepts valid skill code
  it('accepts valid skill code with default export async function and no imports', () => {
    const code = `
export default async function mySkill(input: { message: string }): Promise<string> {
  return \`Hello, \${input.message}\`;
}
`;
    const result: ValidationResult = validator.validate(code);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // Test 2: Rejects import from child_process
  it('rejects code with import { exec } from child_process', () => {
    const code = `
import { exec } from 'child_process';
export default async function mySkill() {
  exec('ls');
}
`;
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('child_process'))).toBe(true);
  });

  // Test 3: Rejects require('child_process')
  it("rejects require('child_process')", () => {
    const code = `
const cp = require('child_process');
export default async function mySkill() {
  cp.execSync('ls');
}
`;
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('child_process'))).toBe(true);
  });

  // Test 4: Rejects import from fs
  it('rejects code with import { readFileSync } from fs', () => {
    const code = `
import { readFileSync } from 'fs';
export default async function mySkill() {
  return readFileSync('/etc/passwd', 'utf8');
}
`;
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('fs'))).toBe(true);
  });

  // Test 5: Rejects import from http
  it('rejects code with import http from http', () => {
    const code = `
import http from 'http';
export default async function mySkill() {
  http.get('http://example.com', () => {});
}
`;
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('http'))).toBe(true);
  });

  // Test 6: Rejects eval() usage
  it('rejects eval() usage', () => {
    const code = `
export default async function mySkill(input: { code: string }) {
  return eval(input.code);
}
`;
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('eval'))).toBe(true);
  });

  // Test 7: Rejects process.env access
  it('rejects process.env access', () => {
    const code = `
export default async function mySkill() {
  return process.env.SECRET_KEY;
}
`;
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('process.env'))).toBe(true);
  });

  // Test 8: Allows fetch() when 'network' permission granted
  it("allows fetch() when 'network' permission granted", () => {
    const code = `
export default async function mySkill(input: { url: string }) {
  const res = await fetch(input.url);
  return res.json();
}
`;
    const resultWithout = validator.validate(code);
    expect(resultWithout.valid).toBe(false);
    expect(resultWithout.errors.some(e => e.includes('fetch'))).toBe(true);

    const resultWith = validator.validate(code, ['network']);
    expect(resultWith.valid).toBe(true);
    expect(resultWith.errors).toHaveLength(0);
  });

  // Test 9: Allows fs when 'filesystem' permission granted
  it("allows fs import when 'filesystem' permission granted", () => {
    const code = `
import { readFileSync } from 'fs';
export default async function mySkill(input: { path: string }) {
  return readFileSync(input.path, 'utf8');
}
`;
    const resultWith = validator.validate(code, ['filesystem']);
    expect(resultWith.valid).toBe(true);
    expect(resultWith.errors).toHaveLength(0);
  });

  // Test 10: Rejects code without export default async function
  it('rejects code without export default async function', () => {
    const code = `
function mySkill(input: { message: string }) {
  return input.message;
}
`;
    const result = validator.validate(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('export default'))).toBe(true);
  });

  // Test 11: Dynamic import bypass is a known limitation
  it('acknowledges dynamic import bypass as a known limitation (passes validation)', () => {
    const code = `
export default async function mySkill() {
  const m = 'child_' + 'process';
  const mod = await import(m);
  mod.execSync('ls');
}
`;
    // This is expected behavior — regex cannot catch dynamic computed imports
    const result = validator.validate(code);
    expect(result.valid).toBe(true);
    // There may be a warning about dynamic imports
  });
});
