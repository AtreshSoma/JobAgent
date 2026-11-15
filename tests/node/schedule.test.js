/**
 * Scheduled runs (audit F11).
 *
 * New matches should be waiting each morning without the dashboard open. This
 * builds the operating system's own scheduler entry (launchd on macOS, cron on
 * Linux, Task Scheduler on Windows) for one search-and-score cycle with a
 * desktop notification (`watch --once --notify`). `npm run schedule` prints
 * it; installing it is a separate, explicit step the person runs.
 */
import { describe, expect, it } from 'vitest';

import { installPlan, parseTime, scheduleEntry } from '../../src/cli/schedule.js';

const base = { root: '/Users/dana/Job Agent', node: '/usr/local/bin/node', home: '/Users/dana' };

describe('parseTime', () => {
  it('reads HH:MM and refuses anything else', () => {
    expect(parseTime('07:30')).toEqual({ hour: 7, minute: 30 });
    expect(parseTime('7:05')).toEqual({ hour: 7, minute: 5 });
    for (const bad of ['24:00', '7', '07:60', 'seven', '']) expect(() => parseTime(bad), bad).toThrow(/HH:MM/);
  });
});

describe('scheduleEntry', () => {
  it('macOS: a launchd agent that runs one cycle at the time, logs to the workspace', () => {
    const e = scheduleEntry({ ...base, platform: 'darwin', time: '07:30' });
    expect(e.kind).toBe('launchd');
    expect(e.path).toBe('/Users/dana/Library/LaunchAgents/com.jobagent.daily.plist');
    expect(e.text).toContain('<key>Hour</key><integer>7</integer>');
    expect(e.text).toContain('<key>Minute</key><integer>30</integer>');
    expect(e.text).toContain('<string>/Users/dana/Job Agent/src/index.js</string>');
    expect(e.text).toContain('<string>--once</string>');
    expect(e.text).toContain('<string>/Users/dana/Job Agent/logs/scheduled.log</string>');
  });

  it('escapes a path that holds XML characters', () => {
    const e = scheduleEntry({ ...base, root: '/Users/dana/R&D <jobs>', platform: 'darwin', time: '07:30' });
    expect(e.text).toContain('R&amp;D &lt;jobs&gt;');
    expect(e.text).not.toContain('R&D <jobs>');
  });

  it('Linux: one tagged cron line, quoting the folder', () => {
    const e = scheduleEntry({ ...base, platform: 'linux', time: '06:05' });
    expect(e.kind).toBe('cron');
    expect(e.text).toBe('5 6 * * * cd "/Users/dana/Job Agent" && "/usr/local/bin/node" src/index.js watch --once --notify >> "/Users/dana/Job Agent/logs/scheduled.log" 2>&1 # jobagent-daily');
  });

  it('Windows: a daily Task Scheduler task', () => {
    const e = scheduleEntry({ root: 'C:\\Users\\Dana\\JobAgent', node: 'C:\\Program Files\\nodejs\\node.exe', home: 'C:\\Users\\Dana', platform: 'win32', time: '07:30' });
    expect(e.kind).toBe('schtasks');
    expect(e.args).toEqual(['/Create', '/SC', 'DAILY', '/TN', 'JobAgent daily search', '/ST', '07:30', '/F',
      '/TR', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Dana\\JobAgent\\src\\index.js" watch --once --notify']);
  });

  it('refuses a folder path with a quote or newline, which no scheduler entry can hold safely', () => {
    expect(() => scheduleEntry({ ...base, root: '/tmp/a"b', platform: 'linux', time: '07:00' })).toThrow(/cannot/i);
  });
});

describe('installPlan', () => {
  it('macOS: writes the agent file and loads it; removal unloads and deletes', () => {
    const e = scheduleEntry({ ...base, platform: 'darwin', time: '07:30' });
    expect(installPlan(e).map((s) => s.op)).toEqual(['write', 'run']);
    expect(installPlan(e).at(-1).args).toEqual(['launchctl', 'load', '-w', e.path]);
    expect(installPlan(e, { remove: true }).map((s) => s.op)).toEqual(['run', 'delete']);
  });

  it('Linux: replaces only its own tagged line in the crontab', () => {
    const e = scheduleEntry({ ...base, platform: 'linux', time: '06:05' });
    const [step] = installPlan(e);
    expect(step.op).toBe('crontab');
    const current = 'MAILTO=x\n0 1 * * * backup.sh\n1 2 * * * old # jobagent-daily\n';
    expect(step.merge(current)).toBe(`MAILTO=x\n0 1 * * * backup.sh\n${e.text}\n`);
    expect(installPlan(e, { remove: true })[0].merge(current)).toBe('MAILTO=x\n0 1 * * * backup.sh\n');
  });

  it('Windows: creates, or deletes, the task', () => {
    const e = scheduleEntry({ root: 'C:\\JobAgent', node: 'node.exe', home: 'C:\\Users\\D', platform: 'win32', time: '07:30' });
    expect(installPlan(e)[0].args[0]).toBe('schtasks');
    expect(installPlan(e, { remove: true })[0].args).toEqual(['schtasks', '/Delete', '/TN', 'JobAgent daily search', '/F']);
  });
});
