/**
 * Smoke test for memory consolidation and backup services.
 *
 * Copies the live database, seeds test messages, then runs:
 *   1. Backup — verifies file creation + integrity check
 *   2. Consolidation — verifies leaf summarization with real agent
 *
 * Usage: npx tsx scripts/smoke-test-consolidation.ts
 */

import { cpSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MemoryDatabase,
  MessageStore,
  SummaryStore,
  ConsolidationService,
  BackupService,
} from '@ccbuddy/memory';
import { loadConfig, createEventBus } from '@ccbuddy/core';
import type { EventBus } from '@ccbuddy/core';

// ── Config ──────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const LIVE_DB = join(PROJECT_ROOT, 'data', 'memory.sqlite');

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(label: string, msg: string) {
  console.log(`\x1b[36m[${label}]\x1b[0m ${msg}`);
}

function pass(msg: string) {
  console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`);
}

function fail(msg: string) {
  console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig(PROJECT_ROOT);

  // Create isolated temp directory
  const tmpDir = join(tmpdir(), `ccbuddy-smoke-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const testDbPath = join(tmpDir, 'test-memory.sqlite');
  const backupDir = join(tmpDir, 'backups');

  console.log(`\n\x1b[1mMemory Consolidation & Backup Smoke Test\x1b[0m`);
  console.log(`Working dir: ${tmpDir}\n`);

  try {
    // ── Step 1: Copy live database ────────────────────────────────────────
    log('SETUP', 'Copying live database...');
    if (!existsSync(LIVE_DB)) {
      fail(`Live database not found at ${LIVE_DB}`);
      process.exit(1);
    }
    cpSync(LIVE_DB, testDbPath);
    // Also copy WAL/SHM if they exist
    if (existsSync(LIVE_DB + '-wal')) cpSync(LIVE_DB + '-wal', testDbPath + '-wal');
    if (existsSync(LIVE_DB + '-shm')) cpSync(LIVE_DB + '-shm', testDbPath + '-shm');
    pass('Database copied');

    // Open the copy
    const db = new MemoryDatabase(testDbPath);
    db.init();
    const messageStore = new MessageStore(db);
    const summaryStore = new SummaryStore(db);
    const eventBus = createEventBus();

    // Check existing data
    const userIds = messageStore.getDistinctUserIds();
    const existingCount = userIds.reduce((sum, uid) => sum + messageStore.getMessageCount(uid), 0);
    log('SETUP', `Found ${existingCount} existing messages across ${userIds.length} user(s)`);

    // ── Step 2: Test Backup ───────────────────────────────────────────────
    console.log('');
    log('BACKUP', 'Creating backup...');

    let backupPath = '';
    let integrityFailed = false;

    eventBus.subscribe('backup.complete', (evt) => {
      backupPath = (evt as any).path;
    });
    eventBus.subscribe('backup.integrity_failed', () => {
      integrityFailed = true;
    });

    const backupService = new BackupService({
      database: db,
      config: { backup_dir: backupDir, max_backups: 3 },
      eventBus,
    });

    await backupService.backup();

    if (integrityFailed) {
      fail('Backup integrity check FAILED');
    } else if (backupPath) {
      pass(`Backup created: ${backupPath.split('/').pop()}`);
      pass('Integrity check passed');

      const backupFiles = readdirSync(backupDir).filter(f => f.endsWith('.sqlite'));
      pass(`${backupFiles.length} backup(s) in directory`);
    } else {
      fail('No backup.complete event received');
    }

    // ── Step 3: Seed test messages ────────────────────────────────────────
    console.log('');
    log('CONSOLIDATION', 'Seeding test messages...');

    const testUserId = '__smoke_test__';
    const baseTimestamp = Date.now() - 3600000; // 1 hour ago

    // Seed 40 messages (well beyond fresh_tail_count of 32)
    for (let i = 0; i < 40; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const content = role === 'user'
        ? `[Test ${i}] What's the capital of ${['France', 'Germany', 'Japan', 'Brazil', 'Australia'][i % 5]}?`
        : `[Test ${i}] The capital is ${['Paris', 'Berlin', 'Tokyo', 'Brasília', 'Canberra'][i % 5]}. It's known for its rich history and culture.`;

      messageStore.add({
        userId: testUserId,
        sessionId: `smoke-test-session`,
        platform: 'test',
        content,
        role: role as 'user' | 'assistant',
        timestamp: baseTimestamp + i * 1000,
      });
    }
    pass(`Seeded 40 test messages for user "${testUserId}"`);

    // ── Step 4: Run consolidation with real agent ─────────────────────────
    log('CONSOLIDATION', 'Running consolidation with real agent summarization...');
    log('CONSOLIDATION', '(This calls Claude via the SDK — may take 10-30 seconds)');

    // Create real summarize closure using CLI fallback (simpler for smoke test)
    const { execFile } = await import('node:child_process');
    const summarize = async (text: string): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        const prompt = `Summarize the following conversation preserving key facts, decisions, and user preferences. Be concise. Output only the summary.\n\n${text}`;
        execFile(
          'claude',
          ['-p', prompt, '--max-turns', '1'],
          { timeout: 60_000 },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(`Claude CLI failed: ${stderr || err.message}`));
              return;
            }
            resolve(stdout.trim());
          },
        );
      });
    };

    const consolidationService = new ConsolidationService({
      messageStore,
      summaryStore,
      database: db,
      config: {
        ...config.memory,
        fresh_tail_count: 32,
        leaf_chunk_tokens: 5000, // smaller chunks for smoke test
        message_retention_days: 30,
      },
      summarize,
    });

    const startTime = Date.now();
    const stats = await consolidationService.consolidate(testUserId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    log('RESULTS', `Consolidation completed in ${elapsed}s`);

    if (stats.messagesChunked > 0) {
      pass(`Messages chunked: ${stats.messagesChunked}`);
    } else {
      fail('No messages were chunked (expected > 0)');
    }

    if (stats.leafNodesCreated > 0) {
      pass(`Leaf nodes created: ${stats.leafNodesCreated}`);
    } else {
      fail('No leaf nodes created (expected > 0)');
    }

    pass(`Condensed nodes created: ${stats.condensedNodesCreated}`);
    pass(`Messages pruned: ${stats.messagesPruned}`);

    // Verify the summary nodes
    const leafNodes = summaryStore.getByDepth(testUserId, 0);
    if (leafNodes.length > 0) {
      pass(`Leaf summary content (first node, ${leafNodes[0].tokens} tokens):`);
      console.log(`\x1b[33m    "${leafNodes[0].content.slice(0, 200)}${leafNodes[0].content.length > 200 ? '...' : ''}"\x1b[0m`);
    }

    // Verify unsummarized count = fresh_tail_count
    const remaining = messageStore.getUnsummarizedMessages(testUserId, 0);
    if (remaining.length === 32) {
      pass(`Remaining unsummarized messages: ${remaining.length} (= fresh_tail_count)`);
    } else {
      log('INFO', `Remaining unsummarized: ${remaining.length} (fresh_tail_count=32)`);
    }

    // ── Step 5: Test rotation ────────────────────────────────────────────
    console.log('');
    log('ROTATION', 'Testing backup rotation (creating 4 backups, max=3)...');
    for (let i = 0; i < 3; i++) {
      await backupService.backup();
    }
    const finalBackups = readdirSync(backupDir).filter(f => f.endsWith('.sqlite'));
    if (finalBackups.length <= 3) {
      pass(`Rotation works: ${finalBackups.length} backups (max 3)`);
    } else {
      fail(`Expected ≤3 backups, got ${finalBackups.length}`);
    }

    // ── Cleanup ──────────────────────────────────────────────────────────
    db.close();

    console.log(`\n\x1b[1;32m✓ Smoke test complete\x1b[0m\n`);
    console.log(`Temp files at: ${tmpDir}`);
    console.log(`Run \x1b[2mrm -rf ${tmpDir}\x1b[0m to clean up\n`);

  } catch (err) {
    console.error('\n\x1b[1;31m✗ Smoke test failed:\x1b[0m', err);
    console.log(`\nTemp files at: ${tmpDir}`);
    process.exit(1);
  }
}

main();
