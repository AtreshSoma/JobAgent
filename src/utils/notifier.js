/**
 * Notifier: surfaces human-actionable events (approval required, errors,
 * run summaries). Defaults to console output. Email/other transports can be
 * injected; no transport dependency is bundled.
 *
 * Never include secrets in notification payloads.
 */

import { redact } from './credentialManager.js';

/** @typedef {'info'|'warn'|'error'|'action_required'} NotifyLevel */

/**
 * Create a notifier.
 *
 * @param {object} [options]
 * @param {(event: {level: NotifyLevel, title: string, message: string, meta: object, at: string}) => void|Promise<void>} [options.sink]
 *   Custom delivery function. Defaults to console output.
 * @param {() => string} [options.now] timestamp source (ISO string), for testing
 */
export function createNotifier({ sink, now = () => new Date().toISOString() } = {}) {
  const deliver = sink ?? defaultConsoleSink;
  const history = [];

  /**
   * @param {NotifyLevel} level
   * @param {string} title
   * @param {string} [message]
   * @param {object} [meta]
   */
  async function notify(level, title, message = '', meta = {}) {
    const event = {
      level,
      title: String(title),
      message: String(message),
      meta: redact(meta),
      at: now(),
    };
    history.push(event);
    await deliver(event);
    return event;
  }

  return {
    info: (title, message, meta) => notify('info', title, message, meta),
    warn: (title, message, meta) => notify('warn', title, message, meta),
    error: (title, message, meta) => notify('error', title, message, meta),
    /** Use when the workflow must pause for explicit human action. */
    actionRequired: (title, message, meta) => notify('action_required', title, message, meta),
    /** Read-only view of everything emitted this run. */
    getHistory: () => history.slice(),
  };
}

/**
 * @param {{level: string, title: string, message: string, at: string}} event
 */
function defaultConsoleSink(event) {
  const line = `[${event.at}] ${event.level.toUpperCase()}: ${event.title}` +
    (event.message ? ` - ${event.message}` : '');
  if (event.level === 'error') {
    console.error(line);
  } else if (event.level === 'warn' || event.level === 'action_required') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
