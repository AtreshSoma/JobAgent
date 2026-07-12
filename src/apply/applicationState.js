/**
 * Durable, privacy-minimized application workflow state.
 *
 * This is deliberately separate from the jobs table. Browser filling changes
 * much more frequently than the job lifecycle row, and a checkpoint must be
 * written after every meaningful browser action so an interrupted process can
 * resume without guessing where it stopped.
 *
 * Persisted field records NEVER contain values. Upload records keep only the
 * document type and basename (never the candidate's absolute path). Screening
 * questions keep the label/reason, never a proposed answer.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';

export const APPLICATION_STATE_VERSION = 1;

export const APPLICATION_PHASE = Object.freeze({
  QUEUED: 'queued',
  PRECHECK: 'precheck',
  OPENING: 'opening',
  FILLING: 'filling',
  VALIDATING: 'validating',
  ADVANCING: 'advancing',
  SUBMITTING: 'submitting',
  VERIFYING: 'verifying',
  BLOCKED: 'blocked',
  READY_FOR_REVIEW: 'ready_for_review',
  USER_SUBMITTED: 'user_submitted',
  VERIFIED: 'verified',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const APPLICATION_PHASE_VALUES = Object.freeze(Object.values(APPLICATION_PHASE));

const TERMINAL_NO_REOPEN = new Set([
  APPLICATION_PHASE.SUBMITTING,
  APPLICATION_PHASE.VERIFYING,
  APPLICATION_PHASE.USER_SUBMITTED,
  APPLICATION_PHASE.VERIFIED,
]);

/** A submitted state is never re-opened, even while verification is pending. */
export function applicationStatePreventsReopen(state) {
  return Boolean(state && TERMINAL_NO_REOPEN.has(state.phase));
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('application-state clock returned an invalid date');
  return date.toISOString();
}

function cleanText(value, max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function persistentUrl(value) {
  const raw = cleanText(value, 4096);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // Credentials and authentication/session material do not belong in an
    // on-disk checkpoint. Ordinary ATS job ids (gh_jid, jobId, etc.) remain.
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:access_?token|auth(?:orization)?|code|password|secret|session|sso)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
}

function jobKey(packet = {}) {
  return cleanText(packet?.job?.id ?? packet?.id ?? packet?.job?.url, 500) ?? 'unknown-application';
}

/**
 * Stable default checkpoint path for a job. The hash prevents collisions and
 * the short readable prefix makes the directory inspectable by a human.
 */
export function applicationStatePath(root, packet = {}) {
  if (!root) return null;
  const key = jobKey(packet);
  const prefix = key.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'application';
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return join(root, 'data', 'application-state', `${prefix}-${digest}.json`);
}

/** Atomic file-backed store used by the live runner. */
export function createFileApplicationStateStore(path) {
  if (!path) throw new Error('application state path is required');
  return {
    path,
    load() {
      if (!existsSync(path)) return null;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        throw new Error(`application state is unreadable (${path}): ${err.message}`);
      }
      validateApplicationState(parsed);
      return parsed;
    },
    save(state) {
      validateApplicationState(state);
      writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      return state;
    },
  };
}

/** Resolve an injected store or the default on-disk store. `false` disables it. */
export function resolveApplicationStateStore({ packet, root, statePath, store } = {}) {
  if (store === false || statePath === false) return null;
  if (store) return store;
  const path = typeof statePath === 'string' ? statePath : applicationStatePath(root, packet);
  return path ? createFileApplicationStateStore(path) : null;
}

/** Create the first queued checkpoint. */
export function createApplicationState(packet = {}, { now } = {}) {
  const at = isoNow(now);
  const state = {
    schemaVersion: APPLICATION_STATE_VERSION,
    stateId: randomUUID(),
    jobId: cleanText(packet?.job?.id, 500),
    packetId: cleanText(packet?.id, 500),
    atsPlatform: cleanText(packet?.ats?.platform, 80) ?? 'generic',
    applicationUrl: persistentUrl(packet?.job?.url),
    phase: APPLICATION_PHASE.QUEUED,
    currentStep: 0,
    completedFields: [],
    unresolvedQuestions: [],
    uploadVerification: [],
    blockers: [],
    lastUrl: persistentUrl(packet?.job?.url),
    createdAt: at,
    updatedAt: at,
    resumeCount: 0,
    phaseTimestamps: { [APPLICATION_PHASE.QUEUED]: { firstAt: at, lastAt: at } },
    history: [{ phase: APPLICATION_PHASE.QUEUED, at, currentStep: 0 }],
  };
  validateApplicationState(state);
  return state;
}

/** Fail closed if a job accidentally resolves to another job's checkpoint. */
export function assertApplicationStateMatchesPacket(state, packet = {}) {
  validateApplicationState(state);
  const packetJobId = cleanText(packet?.job?.id, 500);
  if (state.jobId && packetJobId && state.jobId !== packetJobId) {
    throw new Error(`application state belongs to job ${state.jobId}, not ${packetJobId}`);
  }
  const packetUrl = persistentUrl(packet?.job?.url);
  if (state.applicationUrl && packetUrl && state.applicationUrl !== packetUrl) {
    throw new Error('application state URL does not match this packet');
  }
  return true;
}

function fieldKey(field) {
  return [field.step ?? '', field.field ?? '', field.label ?? ''].join('|');
}

function uploadKey(upload) {
  return String(upload.type ?? upload.fileName ?? 'upload');
}

function mergeBy(items, additions, keyFn) {
  const map = new Map((items ?? []).map((item) => [keyFn(item), item]));
  for (const item of additions ?? []) map.set(keyFn(item), { ...map.get(keyFn(item)), ...item });
  return [...map.values()];
}

export function completedFieldCheckpoint(field = {}, { step, at } = {}) {
  return {
    field: cleanText(field.field, 120),
    label: cleanText(field.label, 240),
    source: cleanText(field.source, 80),
    action: cleanText(field.action, 80) ?? 'fill',
    verified: field.accepted === true || field.verified === true,
    verification: cleanText(field.verification ?? field.reason, 160),
    step: Math.max(0, Number(step ?? field.step ?? 0) || 0),
    completedAt: at,
  };
}

export function unresolvedQuestionCheckpoint(question = {}, { step } = {}) {
  return {
    label: cleanText(question.label ?? question.field, 240) ?? 'unidentified field',
    reason: cleanText(question.reason, 240) ?? 'needs user input',
    required: question.required === true,
    kind: cleanText(question.kind ?? question.type, 80),
    step: Math.max(0, Number(step ?? question.step ?? 0) || 0),
  };
}

export function uploadCheckpoint(upload = {}, { step, at } = {}) {
  return {
    type: cleanText(upload.type, 80) ?? 'upload',
    fileName: upload.path ? cleanText(basename(upload.path), 240) : cleanText(upload.fileName, 240),
    attached: upload.attached !== false,
    verified: upload.verified === true,
    verificationMethod: cleanText(upload.verificationMethod, 120),
    step: Math.max(0, Number(step ?? upload.step ?? 0) || 0),
    checkedAt: at,
  };
}

/**
 * Apply one phase transition and its checkpoint payload.
 *
 * Re-entry from Blocked/Ready for Review is allowed: a resumed run performs a
 * fresh Precheck before opening the saved URL. Verified is terminal.
 */
export function transitionApplicationState(state, nextPhase, patch = {}, { now, detail } = {}) {
  validateApplicationState(state);
  if (!APPLICATION_PHASE_VALUES.includes(nextPhase)) throw new Error(`unknown application phase: ${nextPhase}`);
  if (state.phase === APPLICATION_PHASE.VERIFIED && nextPhase !== APPLICATION_PHASE.VERIFIED) {
    throw new Error('a verified application cannot transition to another phase');
  }
  if (state.phase === APPLICATION_PHASE.USER_SUBMITTED
      && ![APPLICATION_PHASE.USER_SUBMITTED, APPLICATION_PHASE.VERIFIED].includes(nextPhase)) {
    throw new Error('a submitted application cannot be reopened before verification');
  }

  const at = isoNow(now);
  const currentStep = Math.max(0, Number(patch.currentStep ?? state.currentStep ?? 0) || 0);
  const fields = (patch.completedFields ?? []).map((field) => completedFieldCheckpoint(field, { step: currentStep, at }));
  const uploads = (patch.uploadVerification ?? []).map((upload) => uploadCheckpoint(upload, { step: currentStep, at }));
  const unresolved = patch.unresolvedQuestions === undefined
    ? state.unresolvedQuestions
    : (patch.unresolvedQuestions ?? []).map((q) => unresolvedQuestionCheckpoint(q, { step: currentStep }));
  const priorStamp = state.phaseTimestamps?.[nextPhase];
  const entry = {
    phase: nextPhase,
    at,
    currentStep,
    ...(detail ? { detail: cleanText(detail, 500) } : {}),
  };
  const next = {
    ...state,
    phase: nextPhase,
    currentStep,
    completedFields: mergeBy(state.completedFields, fields, fieldKey),
    unresolvedQuestions: unresolved,
    uploadVerification: mergeBy(state.uploadVerification, uploads, uploadKey),
    blockers: patch.blockers === undefined
      ? state.blockers
      : [...new Set((patch.blockers ?? []).map((b) => cleanText(b, 500)).filter(Boolean))],
    lastUrl: persistentUrl(patch.lastUrl ?? state.lastUrl),
    updatedAt: at,
    resumeCount: Math.max(0, Number(patch.resumeCount ?? state.resumeCount ?? 0) || 0),
    phaseTimestamps: {
      ...state.phaseTimestamps,
      [nextPhase]: { firstAt: priorStamp?.firstAt ?? at, lastAt: at },
    },
    history: [...(state.history ?? []), entry].slice(-250),
  };
  if ([APPLICATION_PHASE.SUBMITTING, APPLICATION_PHASE.USER_SUBMITTED].includes(nextPhase)) {
    next.submittedAt = state.submittedAt ?? at;
    next.submissionEvidence = sanitizeEvidence(patch.submissionEvidence ?? state.submissionEvidence);
  }
  if (nextPhase === APPLICATION_PHASE.VERIFYING) {
    next.submittedAt = state.submittedAt ?? at;
    next.submissionEvidence = sanitizeEvidence(patch.submissionEvidence ?? state.submissionEvidence);
  }
  if (nextPhase === APPLICATION_PHASE.VERIFIED) {
    next.verifiedAt = state.verifiedAt ?? at;
    next.verificationEvidence = sanitizeEvidence(patch.verificationEvidence ?? state.verificationEvidence);
  }
  validateApplicationState(next);
  return next;
}

function sanitizeEvidence(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map((v) => cleanText(v, 240)).filter(Boolean))].slice(0, 20);
}

export function validateApplicationState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('application state must be an object');
  if (state.schemaVersion !== APPLICATION_STATE_VERSION) throw new Error(`unsupported application state version: ${state.schemaVersion}`);
  if (!APPLICATION_PHASE_VALUES.includes(state.phase)) throw new Error(`invalid application state phase: ${state.phase}`);
  if (!Number.isInteger(state.currentStep) || state.currentStep < 0) throw new Error('application state currentStep must be a non-negative integer');
  for (const key of ['completedFields', 'unresolvedQuestions', 'uploadVerification', 'blockers', 'history']) {
    if (!Array.isArray(state[key])) throw new Error(`application state ${key} must be an array`);
  }
  // Privacy invariant: persisted completion/question records cannot contain
  // typed answers, values, or absolute document paths.
  for (const item of [...state.completedFields, ...state.unresolvedQuestions, ...state.uploadVerification]) {
    for (const forbidden of ['value', 'answer', 'path']) {
      if (Object.hasOwn(item, forbidden)) throw new Error(`application state must not persist ${forbidden}`);
    }
  }
  return true;
}

async function loadStore(store) {
  return store ? await store.load?.() : null;
}

async function saveStore(store, state) {
  if (store) await store.save?.(state);
  return state;
}

/** Record the human-controlled final submit without claiming verification. */
export async function markApplicationUserSubmitted({ store, statePath, root, packet, now, evidence = [] } = {}) {
  const target = resolveApplicationStateStore({ packet, root, statePath, store });
  if (!target) throw new Error('application state persistence is not configured');
  const state = await loadStore(target);
  if (!state) throw new Error('application state does not exist');
  if (packet) assertApplicationStateMatchesPacket(state, packet);
  const next = transitionApplicationState(state, APPLICATION_PHASE.USER_SUBMITTED, {
    submissionEvidence: evidence,
    blockers: [],
  }, { now, detail: 'human reported final submission' });
  return saveStore(target, next);
}

/** Mark a previously submitted application verified from explicit evidence. */
export async function markApplicationVerified({ store, statePath, root, packet, now, evidence = [] } = {}) {
  const target = resolveApplicationStateStore({ packet, root, statePath, store });
  if (!target) throw new Error('application state persistence is not configured');
  const state = await loadStore(target);
  if (!state) throw new Error('application state does not exist');
  if (packet) assertApplicationStateMatchesPacket(state, packet);
  if (![APPLICATION_PHASE.SUBMITTING, APPLICATION_PHASE.VERIFYING,
    APPLICATION_PHASE.USER_SUBMITTED, APPLICATION_PHASE.VERIFIED].includes(state.phase)) {
    throw new Error('application must be user_submitted before it can be verified');
  }
  const proof = sanitizeEvidence(evidence);
  if (!proof.length && state.phase !== APPLICATION_PHASE.VERIFIED) {
    throw new Error('verification evidence is required');
  }
  const next = transitionApplicationState(state, APPLICATION_PHASE.VERIFIED, {
    verificationEvidence: proof.length ? proof : state.verificationEvidence,
    blockers: [],
  }, { now, detail: 'submission verified' });
  return saveStore(target, next);
}
