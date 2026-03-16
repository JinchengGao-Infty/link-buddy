import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { CCBuddyConfig, DEFAULT_CONFIG } from './schema.js';

/**
 * Deep merge: properties from `source` overwrite those in `target`.
 * Arrays are replaced (not merged). Non-plain-object values are replaced.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = structuredClone(target);
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Recursively resolve ${ENV_VAR} placeholders in string values of an object.
 */
function resolvePlaceholders<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? _match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(resolvePlaceholders) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolvePlaceholders(v);
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Apply CCBUDDY_* env var overrides to config.
 * - CCBUDDY_LOG_LEVEL → config.log_level (single underscore = top-level key lowercased)
 * - CCBUDDY_AGENT__BACKEND → config.agent.backend (double underscore = nesting separator)
 */
function applyEnvOverrides(config: CCBuddyConfig): CCBuddyConfig {
  const result = structuredClone(config);
  const prefix = 'CCBUDDY_';

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith(prefix) || envVal === undefined) continue;
    const rest = envKey.slice(prefix.length);

    // Split on double underscore for nesting, then single underscore for key
    // e.g. CCBUDDY_AGENT__BACKEND → ['AGENT', 'BACKEND'] → ['agent', 'backend']
    // e.g. CCBUDDY_LOG_LEVEL → ['LOG_LEVEL'] → 'log_level'
    const parts = rest.split('__').map((p) => p.toLowerCase());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let obj: Record<string, any> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      if (obj[segment] !== undefined && typeof obj[segment] === 'object' && obj[segment] !== null) {
        obj = obj[segment] as Record<string, unknown>;
      } else {
        obj = undefined as unknown as Record<string, unknown>;
        break;
      }
    }
    if (obj !== undefined) {
      const lastKey = parts[parts.length - 1];
      // Preserve type: if existing value is a number, coerce
      const existing = obj[lastKey];
      if (typeof existing === 'number') {
        const parsed = Number(envVal);
        if (!isNaN(parsed)) obj[lastKey] = parsed;
      } else if (typeof existing === 'boolean') {
        obj[lastKey] = envVal === 'true' || envVal === '1';
      } else {
        obj[lastKey] = envVal;
      }
    }
  }

  return result;
}

/**
 * Load config from a directory:
 * 1. Start with DEFAULT_CONFIG
 * 2. Merge default.yaml (if present)
 * 3. Merge local.yaml (if present)
 * 4. Resolve ${ENV_VAR} placeholders
 * 5. Apply CCBUDDY_* env var overrides
 */
export function loadConfig(configDir: string): CCBuddyConfig {
  let config: CCBuddyConfig = structuredClone(DEFAULT_CONFIG);

  for (const filename of ['default.yaml', 'local.yaml']) {
    const filePath = join(configDir, filename);
    if (!existsSync(filePath)) continue;

    const raw = readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(raw) as { ccbuddy?: Partial<CCBuddyConfig> } | null;
    if (parsed?.ccbuddy) {
      config = deepMerge(
        config as unknown as Record<string, unknown>,
        parsed.ccbuddy as Record<string, unknown>,
      ) as unknown as CCBuddyConfig;
    }
  }

  config = resolvePlaceholders(config) as CCBuddyConfig;
  config = applyEnvOverrides(config);

  return config;
}
