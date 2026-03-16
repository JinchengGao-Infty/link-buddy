import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Config Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccbuddy-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads default config from yaml', () => {
    const yamlContent = `
ccbuddy:
  data_dir: "./data"
  log_level: "info"
  agent:
    backend: "sdk"
    max_concurrent_sessions: 3
`;
    writeFileSync(join(tmpDir, 'default.yaml'), yamlContent);
    const config = loadConfig(tmpDir);
    expect(config.data_dir).toBe('./data');
    expect(config.log_level).toBe('info');
    expect(config.agent.backend).toBe('sdk');
    expect(config.agent.max_concurrent_sessions).toBe(3);
  });

  it('local.yaml overrides default.yaml', () => {
    writeFileSync(join(tmpDir, 'default.yaml'), 'ccbuddy:\n  log_level: "info"\n  agent:\n    backend: "sdk"\n');
    writeFileSync(join(tmpDir, 'local.yaml'), 'ccbuddy:\n  log_level: "debug"\n');
    const config = loadConfig(tmpDir);
    expect(config.log_level).toBe('debug');
    expect(config.agent.backend).toBe('sdk');
  });

  it('env vars override yaml (CCBUDDY_ prefix, top-level)', () => {
    writeFileSync(join(tmpDir, 'default.yaml'), 'ccbuddy:\n  log_level: "info"\n');
    process.env.CCBUDDY_LOG_LEVEL = 'warn';
    try {
      const config = loadConfig(tmpDir);
      expect(config.log_level).toBe('warn');
    } finally {
      delete process.env.CCBUDDY_LOG_LEVEL;
    }
  });

  it('env vars override nested yaml (double underscore separator)', () => {
    writeFileSync(join(tmpDir, 'default.yaml'), 'ccbuddy:\n  agent:\n    backend: "sdk"\n');
    process.env.CCBUDDY_AGENT__BACKEND = 'cli';
    try {
      const config = loadConfig(tmpDir);
      expect(config.agent.backend).toBe('cli');
    } finally {
      delete process.env.CCBUDDY_AGENT__BACKEND;
    }
  });

  it('resolves ${ENV_VAR} placeholders in yaml values', () => {
    writeFileSync(join(tmpDir, 'default.yaml'), 'ccbuddy:\n  platforms:\n    discord:\n      token: "${DISCORD_BOT_TOKEN}"\n');
    process.env.DISCORD_BOT_TOKEN = 'test-token-123';
    try {
      const config = loadConfig(tmpDir);
      expect(config.platforms.discord?.token).toBe('test-token-123');
    } finally {
      delete process.env.DISCORD_BOT_TOKEN;
    }
  });

  it('returns sensible defaults when config dir has no files', () => {
    const emptyDir = join(tmpDir, 'empty');
    mkdirSync(emptyDir);
    const config = loadConfig(emptyDir);
    expect(config.log_level).toBe('info');
    expect(config.agent.backend).toBe('sdk');
  });
});
