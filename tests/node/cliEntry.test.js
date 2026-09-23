/**
 * The CLI entry point must never start work the user did not ask for.
 *
 * `node src/index.js --help`, `-h` and a bare `node src/index.js` all used to
 * fall into the legacy path and run a live DRY_RUN discovery across every
 * enabled source. These tests pin the replacement behaviour: help is printed,
 * nothing is loaded, and the legacy pipeline needs an explicit mode.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Prove "nothing was loaded": if help/version/bad-mode paths reach config,
// this mock records it. It also lets one test simulate dotenv populating the
// environment, which is what `--mode` (no value) must honour.
const loadConfigCalls = [];
let loadConfigEffect = () => { throw new Error('loadConfig must not be reached in this test'); };
vi.mock('../../src/config/loadConfig.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: (args) => { loadConfigCalls.push(args); return loadConfigEffect(args); },
  };
});

const { main, helpText, COMMAND_TABLE, resolveMode, parseArgs, runRescore } = await import('../../src/index.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let stdout;
beforeEach(() => {
  loadConfigCalls.length = 0;
  loadConfigEffect = () => { throw new Error('loadConfig must not be reached in this test'); };
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => { stdout.mockRestore(); });

const printed = () => stdout.mock.calls.map((c) => String(c[0])).join('');

describe('help never starts a pipeline run', () => {
  it.each([
    [['--help']], [['-h']], [['help']], [[]],
  ])('%j prints help and loads nothing', async (argv) => {
    const result = await main(argv, {});
    expect(result).toEqual({ command: 'help' });
    expect(printed()).toMatch(/Usage:/);
    expect(loadConfigCalls).toEqual([]);
  });

  it('--version prints the package version and loads nothing', async () => {
    const result = await main(['--version'], {});
    expect(result).toEqual({ command: 'version', version: pkg.version });
    expect(printed().trim()).toBe(pkg.version);
    expect(loadConfigCalls).toEqual([]);
  });

  it('lists every visible command from the table, with a description', () => {
    const text = helpText();
    for (const c of COMMAND_TABLE.filter((x) => !x.hidden)) {
      expect(text).toContain(c.name);
      expect(text).toContain(c.summary);
    }
    expect(text).not.toContain('live-submit');
  });

  it('every `node src/index.js <command>` npm script names a command in the table', () => {
    const known = new Set(COMMAND_TABLE.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const used = Object.values(pkg.scripts)
      .map((s) => /^node src\/index\.js ([a-z][a-z-]*)/.exec(s)?.[1])
      .filter(Boolean);
    expect(used.length).toBeGreaterThan(5);
    for (const name of used) expect(known.has(name), name).toBe(true);
  });
});

describe('the legacy mode path needs an explicit, valid mode', () => {
  it('rejects an unknown --mode before touching config', async () => {
    await expect(main(['--mode=PREPAER'], {})).rejects.toThrow(/unknown run mode --mode=PREPAER/);
    expect(loadConfigCalls).toEqual([]);
  });

  it('rejects the removed LIVE_SUBMIT instead of silently running DRY_RUN', () => {
    expect(() => resolveMode(parseArgs(['--mode=LIVE_SUBMIT']), {})).toThrow(/DRY_RUN, PREPARE, LIVE_ASSIST/);
  });

  it('accepts modes case-insensitively, like RUN_MODE does', () => {
    expect(resolveMode(parseArgs(['--mode=prepare']), {})).toBe('PREPARE');
  });

  it('a bare --mode reads RUN_MODE only after .env has been loaded', async () => {
    const env = {};
    // Simulates dotenv: loadConfig is what puts .env values into the env.
    loadConfigEffect = () => { env.RUN_MODE = 'FROM_DOTENV'; return {}; };
    await expect(main(['--mode'], env)).rejects.toThrow(/RUN_MODE=FROM_DOTENV/);
    expect(loadConfigCalls).toHaveLength(1);
  });

  it('an unknown command still fails and points at help', async () => {
    await expect(main(['discovr'], {})).rejects.toThrow(/unknown command "discovr".*help/);
  });
});

describe('rescore', () => {
  it('explains a missing rescoreStale export instead of crashing', async () => {
    const previous = process.exitCode;
    const fail = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = await runRescore({ config: {}, db: {}, logger: null, importPipeline: async () => ({}) });
      expect(r.ok).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      fail.mockRestore();
      process.exitCode = previous;
    }
  });

  it('delegates to rescoreStale with the command context and reports its counts', async () => {
    const rescoreStale = vi.fn(async () => ({ counters: { rescored: 3, unchanged: 7 } }));
    const ctx = { config: { root: '/x' }, db: {}, logger: {} };
    const r = await runRescore({ ...ctx, importPipeline: async () => ({ rescoreStale }) });
    expect(rescoreStale).toHaveBeenCalledWith(ctx);
    expect(r).toMatchObject({ ok: true, counters: { rescored: 3 } });
    expect(printed()).toMatch(/rescored/);
  });
});
