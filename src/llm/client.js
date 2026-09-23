/**
 * Minimal OpenAI-compatible chat client for the OPTIONAL LLM assist layer.
 *
 * Deliberately dependency-free (global fetch only) so enabling LLM assist never
 * adds an npm dependency to the core agent, and disabling it costs nothing.
 *
 * Everything about this layer is opt-in and fail-safe:
 *   - Off unless LLM_ASSIST=on AND a key is present.
 *   - Hard timeout and a token ceiling on every call.
 *   - Any error, timeout, or malformed reply resolves to `{ ok: false }`. It
 *     never throws into the pipeline, because a resume must still be produced
 *     when the network is down.
 *   - Responses are cached on disk by content hash so re-preparing the same job
 *     is free and does not re-bill the account.
 *
 * Provider is configurable; the shipped default targets NVIDIA's
 * OpenAI-compatible endpoint. No provider SDK is required.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { withRetry } from '../utils/retryHandler.js';

/** Default provider endpoint (OpenAI-compatible /chat/completions). */
export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
/** Default model. */
export const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
/** Hard wall-clock ceiling for one call. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Retries after the first attempt for 429 / 5xx / transient network errors. */
const MAX_RETRIES = 2;
/** Longest Retry-After we will honour (a provider asking for minutes is a failure). */
const MAX_RETRY_DELAY_MS = 10_000;
/** Never send more JD text than this (cost + latency ceiling). */
const MAX_INPUT_CHARS = 24_000;

/**
 * Resolve LLM assist settings from the environment.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   enabled: boolean, reason: string|null, apiKey: string,
 *   baseUrl: string, model: string, timeoutMs: number, cacheDir: string|null
 * }}
 */
export function llmSettings(env = process.env, { root = null } = {}) {
  const flag = String(env.LLM_ASSIST ?? '').trim().toLowerCase();
  const apiKey = String(env.NVIDIA_API_KEY ?? env.LLM_API_KEY ?? '').trim();
  const on = ['1', 'on', 'true', 'yes', 'enabled'].includes(flag);

  let reason = null;
  if (!on) reason = 'LLM_ASSIST is not enabled (set LLM_ASSIST=on in .env)';
  else if (!apiKey) reason = 'no API key found (set NVIDIA_API_KEY in .env)';

  return {
    enabled: on && Boolean(apiKey),
    reason,
    apiKey,
    baseUrl: String(env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: String(env.LLM_MODEL ?? DEFAULT_MODEL),
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    cacheDir: root ? join(root, '.tmp', 'llm-cache') : null,
  };
}

/**
 * Stable cache key for one request.
 *
 * The separator is U+0000 written as the `\u0000` ESCAPE. It used to be two
 * literal NUL bytes in the source, which made git treat this file as binary
 * (no diffs, no blame). The escape hashes to the same bytes, so existing
 * cache entries remain valid.
 */
function cacheKey({ model, system, user }) {
  return createHash('sha256')
    .update(`${model}\u0000${system}\u0000${user}`)
    .digest('hex')
    .slice(0, 32);
}

function readCache(dir, key) {
  if (!dir) return null;
  try { return JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')); }
  catch { return null; }
}

function writeCache(dir, key, value) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${key}.json`), JSON.stringify(value), 'utf8');
  } catch { /* caching is best-effort */ }
}

/**
 * Ask the model for a JSON object.
 *
 * @param {object} args
 * @param {string} args.system system prompt
 * @param {string} args.user user prompt (truncated to MAX_INPUT_CHARS)
 * @param {object} [args.settings] llmSettings() result
 * @param {number} [args.maxTokens=1600]
 * @param {object} [deps] { fetchImpl, sleepFn, maxRetries } for tests
 * @returns {Promise<{ ok: boolean, data: any, error: string|null, cached: boolean, model: string }>}
 */
export async function completeJson({
  system, user, settings, maxTokens = 1600,
} = {}, deps = {}) {
  const cfg = settings ?? llmSettings();
  const fail = (error) => ({ ok: false, data: null, error, cached: false, model: cfg.model });

  if (!cfg.enabled) return fail(cfg.reason ?? 'LLM assist disabled');

  const prompt = String(user ?? '').slice(0, MAX_INPUT_CHARS);
  const key = cacheKey({ model: cfg.model, system, user: prompt });
  const hit = readCache(cfg.cacheDir, key);
  if (hit) return { ok: true, data: hit, error: null, cached: true, model: cfg.model };

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return fail('no fetch implementation available');

  const body = JSON.stringify({
    model: cfg.model,
    // Deterministic: the same JD must yield the same requirements, or the
    // audit trail on a re-prepared resume becomes meaningless.
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  });

  // One attempt = request AND body. The timer used to be cleared as soon as
  // headers arrived, so a provider that sent headers and then stalled the
  // body hung `response.json()` with no limit at all.
  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const response = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        // Never leak the key or full provider payload into a packet/log.
        const err = new Error(`provider returned HTTP ${response.status}`);
        err.status = response.status;
        const retryAfterMs = retryAfterToMs(response.headers?.get?.('retry-after'));
        if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const wrapped = new Error(`could not read provider response: ${err.message}`);
        wrapped.retryable = false;
        throw wrapped;
      }
      return payload?.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  };

  let text;
  try {
    // Bounded retries for 429 / 5xx / transient network errors only (see
    // defaultIsRetryable), honouring Retry-After up to MAX_RETRY_DELAY_MS.
    // A timeout is not retried: it already cost the full budget once.
    text = await withRetry(attempt, {
      maxRetries: deps.maxRetries ?? MAX_RETRIES,
      baseDelayMs: 500,
      maxDelayMs: MAX_RETRY_DELAY_MS,
      ...(deps.sleepFn ? { sleepFn: deps.sleepFn } : {}),
    });
  } catch (err) {
    if (err?.name === 'AbortError') return fail(`timed out after ${cfg.timeoutMs}ms`);
    if (typeof err?.status === 'number' || /^could not read provider response/.test(err?.message ?? '')) {
      return fail(err.message);
    }
    return fail(`request failed: ${err?.message ?? err}`);
  }

  const parsed = parseJsonObject(text);
  if (!parsed) return fail('provider did not return parseable JSON');

  writeCache(cfg.cacheDir, key, parsed);
  return { ok: true, data: parsed, error: null, cached: false, model: cfg.model };
}

/**
 * Retry-After header -> milliseconds (delta-seconds or HTTP-date), or null.
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {number|null}
 */
export function retryAfterToMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * Parse a JSON object out of a model reply, tolerating ```json fences and
 * surrounding prose. Returns null when nothing usable is present.
 */
export function parseJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const attempts = [unfenced];
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(unfenced.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* try the next shape */ }
  }
  return null;
}
