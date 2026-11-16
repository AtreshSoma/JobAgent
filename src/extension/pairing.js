/**
 * Pair the browser extension with a short code (audit A12).
 *
 * Before: the person copied a 32+ character key from .env into the extension's
 * settings page. Now the dashboard shows a code like `K7QM-4XWD`; the
 * extension's settings page sends it to the local server and receives the key,
 * once. The code lasts five minutes, works one time, a new code replaces the
 * old, and five wrong guesses lock pairing for a minute (so the code cannot be
 * guessed: 32^8 possibilities against five tries a minute).
 *
 * The key itself is unchanged: JOB_AGENT_EXTENSION_KEY when set, otherwise one
 * the dashboard makes and keeps in data/extension_key. Pasting a key by hand
 * still works.
 */
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { workspacePaths } from '../profile/workspace.js';

/** No 0, O, 1 or I: a code is read off a screen and typed. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const NEUTRAL_ERROR = 'That code did not work. Show a new code in the dashboard and try again.';

const normalize = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const same = (a, b) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * @param {{now?: () => number, ttlMs?: number, maxFailures?: number, lockMs?: number}} [options]
 */
export function createPairing({ now = Date.now, ttlMs = 5 * 60_000, maxFailures = 5, lockMs = 60_000 } = {}) {
  let current = null; // { code, expiresAt }
  let failures = 0;
  let lockedUntil = 0;

  return {
    /** A new code; it replaces any earlier one. */
    issue() {
      let raw = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
      current = { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, raw, expiresAt: now() + ttlMs };
      return { code: current.code, expiresAt: new Date(current.expiresAt).toISOString() };
    },
    /**
     * @returns {{ok: true, key: string} | {ok: false, error: string, retryAfterMs?: number}}
     */
    redeem(code, key) {
      const t = now();
      if (t < lockedUntil) return { ok: false, error: 'Too many wrong codes. Wait a minute, then show a new code.', retryAfterMs: lockedUntil - t };
      const fail = () => {
        failures += 1;
        if (failures >= maxFailures) { lockedUntil = t + lockMs; failures = 0; }
        return { ok: false, error: NEUTRAL_ERROR };
      };
      if (!current || t > current.expiresAt) return fail();
      if (!same(normalize(code), current.raw)) return fail();
      current = null; failures = 0;
      return { ok: true, key };
    },
  };
}

/**
 * The extension key kept for this workspace, made on first use: 64 hex
 * characters, readable by this user only.
 */
export function ensureExtensionKey(root) {
  const dir = workspacePaths(root).dataDir;
  const file = join(dir, 'extension_key');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* none yet */ }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort on this filesystem */ }
  return key;
}
