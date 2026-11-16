#!/usr/bin/env node
/**
 * Run a search every morning without the dashboard open (audit F11).
 *
 *   npm run schedule                    show the entry for this computer
 *   npm run schedule -- --time 06:45    ...at another time
 *   npm run schedule -- --install       add it to the operating system's scheduler
 *   npm run schedule -- --remove        take it out again
 *
 * The scheduled run searches, scores and shows a desktop notification
 * (`watch --once --notify`). It never prepares, fills or submits anything.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installPlan, scheduleEntry } from '../src/cli/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main() {
  const entry = scheduleEntry({ platform: process.platform, root: ROOT, node: process.execPath, home: homedir(), time: option('--time') ?? '07:30' });
  const remove = flag('--remove');
  if (!flag('--install') && !remove) {
    console.log(`A daily search at ${entry.time} would use your system's ${entry.kind === 'launchd' ? 'launchd' : entry.kind === 'cron' ? 'crontab' : 'Task Scheduler'}:\n`);
    console.log(entry.path ? `${entry.path}:\n\n${entry.text}` : entry.text);
    console.log('\nAdd it with:     npm run schedule -- --install');
    console.log('Remove it with:  npm run schedule -- --remove');
    return;
  }
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  for (const step of installPlan(entry, { remove })) {
    if (step.op === 'write') { mkdirSync(dirname(step.path), { recursive: true }); writeFileSync(step.path, step.text); }
    if (step.op === 'delete' && existsSync(step.path)) rmSync(step.path);
    if (step.op === 'run') {
      const r = spawnSync(step.args[0], step.args.slice(1), { stdio: 'inherit' });
      if (r.status !== 0 && !step.optional) throw new Error(`${step.args[0]} failed (exit ${r.status})`);
    }
    if (step.op === 'crontab') {
      const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      const next = step.merge(current.status === 0 ? current.stdout : '');
      const r = spawnSync('crontab', ['-'], { input: next, stdio: ['pipe', 'inherit', 'inherit'] });
      if (r.status !== 0) throw new Error('crontab could not be updated');
    }
  }
  console.log(remove ? 'Removed the daily search.' : `Added: a search runs every day at ${entry.time}. Its log is logs/scheduled.log.`);
}

try { main(); } catch (err) { console.error(err.message); process.exit(1); }
