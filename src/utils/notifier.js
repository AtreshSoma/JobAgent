/**
 * Notifier: surfaces human-actionable events (approval required, errors,
 * run summaries). Defaults to console output. Other transports can be
 * injected; no transport dependency is bundled.
 *
 * Production use: `npm run watch` with WATCH_NOTIFY=1 raises a desktop
 * notification for each cycle that finds new strong matches, through
 * `createDesktopSink()` below (macOS Notification Center via osascript, Linux
 * via notify-send; a terminal bell + console line elsewhere, or when those
 * binaries are missing).
 *
 * Never include secrets in notification payloads.
 */

import { spawn } from 'node:child_process';

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

/** Keep notification text short: OS popups truncate anyway. */
function clip(text, max = 180) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A sink that raises an OS desktop notification.
 *
 * Robust by construction: the text travels as argv (never through a shell or
 * an interpolated script, so a job title cannot inject anything), a missing
 * notifier binary is caught through the child's 'error' event, and ANY failure
 * degrades to the terminal fallback. Windows has no dependency-free toast API
 * short of a PowerShell module, so it uses the fallback directly.
 *
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform=process.platform]
 * @param {typeof spawn} [options.spawnImpl=spawn]
 * @param {(event: object) => void} [options.fallback] terminal bell + console line
 * @returns {(event: {level: string, title: string, message: string, at: string}) => void}
 */
export function createDesktopSink({
  platform = process.platform, spawnImpl = spawn, fallback = terminalSink,
} = {}) {
  return function desktopSink(event) {
    const title = clip(event.title, 80);
    const message = clip(event.message);
    let cmd = null;
    let args = null;
    if (platform === 'darwin') {
      // The AppleScript reads its text from argv, so nothing needs escaping.
      cmd = 'osascript';
      args = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e', 'end run', title, message];
    } else if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
      cmd = 'notify-send';
      // `--` ends option parsing: a job title such as "-u critical" (scraped
      // text) must be shown, never read as a notify-send flag.
      args = ['--app-name=Job Agent', '--', title, message];
    }
    if (!cmd) {
      fallback(event);
      return;
    }
    try {
      const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true });
      child?.once?.('error', () => fallback(event));
      child?.unref?.();
    } catch {
      fallback(event);
    }
  };
}

/** Terminal fallback: a bell plus the console line. */
function terminalSink(event) {
  process.stdout.write('\u0007');
  defaultConsoleSink(event);
}
