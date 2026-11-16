/**
 * Scheduled runs (audit F11).
 *
 * Builds the operating system's own scheduler entry for one search-and-score
 * cycle with a desktop notification (`watch --once --notify`), so new matches
 * are waiting each morning without the dashboard open:
 *
 *   macOS   a launchd agent in ~/Library/LaunchAgents
 *   Linux   one tagged line in the user's crontab
 *   Windows a daily Task Scheduler task
 *
 * Pure: `scheduleEntry` describes the entry and `installPlan` lists the steps
 * to add or remove it. scripts/schedule.mjs prints them, and carries them out
 * only when the person asks (--install / --remove). The cycle never applies
 * to anything: it searches, scores and notifies.
 */
import { join as posixJoin } from 'node:path/posix';
import { join as winJoin } from 'node:path/win32';

export const LAUNCHD_LABEL = 'com.jobagent.daily';
export const CRON_TAG = '# jobagent-daily';
export const TASK_NAME = 'JobAgent daily search';
const CYCLE = ['watch', '--once', '--notify'];

/** "07:30" -> {hour: 7, minute: 30}; throws on anything else. */
export function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!m || hour > 23 || minute > 59) throw new Error(`give the time as HH:MM in 24-hour time, such as 07:30 (got "${text}")`);
  return { hour, minute };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {{platform: string, root: string, node: string, home: string, time?: string}} args
 * @returns {{kind: 'launchd'|'cron'|'schtasks', text: string, path?: string, args?: string[], time: string}}
 */
export function scheduleEntry({ platform, root, node, home, time = '07:30' }) {
  for (const p of [root, node, home]) {
    if (/["\r\n]/.test(String(p ?? ''))) throw new Error(`a scheduler entry cannot hold this path safely: ${JSON.stringify(p)}`);
  }
  const { hour, minute } = parseTime(time);
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  if (platform === 'win32') {
    const tr = `"${node}" "${winJoin(root, 'src', 'index.js')}" ${CYCLE.join(' ')}`;
    const args = ['/Create', '/SC', 'DAILY', '/TN', TASK_NAME, '/ST', hhmm, '/F', '/TR', tr];
    return { kind: 'schtasks', args, text: `schtasks ${args.map((a) => (/\s|"/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}`, time: hhmm };
  }

  const log = posixJoin(root, 'logs', 'scheduled.log');
  if (platform === 'darwin') {
    const program = [node, posixJoin(root, 'src', 'index.js'), ...CYCLE].map((a) => `    <string>${xml(a)}</string>`).join('\n');
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    return { kind: 'launchd', path: posixJoin(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`), text, time: hhmm };
  }

  const text = `${minute} ${hour} * * * cd "${root}" && "${node}" src/index.js ${CYCLE.join(' ')} >> "${log}" 2>&1 ${CRON_TAG}`;
  return { kind: 'cron', text, time: hhmm };
}

/**
 * The steps that add (or remove) an entry. Ops: write {path, text}, delete
 * {path}, run {args}, crontab {merge(current) -> next}.
 */
export function installPlan(entry, { remove = false } = {}) {
  if (entry.kind === 'launchd') {
    return remove
      ? [{ op: 'run', args: ['launchctl', 'unload', '-w', entry.path], optional: true }, { op: 'delete', path: entry.path }]
      : [{ op: 'write', path: entry.path, text: entry.text }, { op: 'run', args: ['launchctl', 'load', '-w', entry.path] }];
  }
  if (entry.kind === 'cron') {
    const merge = (current) => {
      const kept = String(current ?? '').split('\n').filter((l) => l.trim() && !l.endsWith(CRON_TAG));
      return `${[...kept, ...(remove ? [] : [entry.text])].join('\n')}\n`;
    };
    return [{ op: 'crontab', merge }];
  }
  return remove
    ? [{ op: 'run', args: ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'] }]
    : [{ op: 'run', args: ['schtasks', ...entry.args] }];
}
