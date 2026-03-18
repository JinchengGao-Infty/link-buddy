#!/usr/bin/env node
import { appendFileSync } from 'fs';

const LOG = '/Users/flyingchickens/Documents/Projects/CCBuddy/data/ccbuddy.log';
const log = (msg) => appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);

const origLog = console.log;
const origErr = console.error;
console.log = (...a) => { log(a.join(' ')); origLog(...a); };
console.error = (...a) => { log('ERR: ' + a.join(' ')); origErr(...a); };
process.on('unhandledRejection', (err) => { log('UNHANDLED: ' + (err?.stack || err)); });

log('Starting CCBuddy...');
const { bootstrap } = await import('../packages/main/dist/bootstrap.js');
const result = await bootstrap(
  '/Users/flyingchickens/Documents/Projects/CCBuddy/config',
);
log('CCBuddy running');

process.on('SIGTERM', async () => { log('SIGTERM received'); await result.stop(); process.exit(0); });
process.on('SIGINT', async () => { log('SIGINT received'); await result.stop(); process.exit(0); });
