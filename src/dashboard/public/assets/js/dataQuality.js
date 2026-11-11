/**
 * The "Discovery & data quality" dialog: freshness and retention settings,
 * description fetching (enable, run, stop, progress), and why jobs were
 * filtered. Everything shown comes from GET /api/data-quality.
 */

import { $, el, fmt, shortStamp, toast, withBusy } from './dom.js';
import { api, postJson } from './api.js';
import { openDialog } from './dialogs.js';
import { miniTable } from './reports.js';

const WINDOW_OPTIONS = [
  ['LAST_24_HOURS', 'the last 24 hours'], ['LAST_3_DAYS', 'the last 3 days'], ['LAST_7_DAYS', 'the last 7 days'],
  ['LAST_14_DAYS', 'the last 14 days'], ['LAST_30_DAYS', 'the last 30 days'], ['ALL', 'any time'],
];
const SOURCE_NOTE = {
  settings: 'set here',
  env: 'from .env (JOB_FRESHNESS_MODE)',
  config: 'from config/exclusions.json',
};

let pollTimer = null;
const dialog = () => $('dlgDataQuality');

export async function openDataQuality() {
  const body = $('dataQualityBody');
  body.textContent = '';
  body.append(el('div', { class: 'muted', role: 'status', text: 'Reading the job store…' }));
  openDialog(dialog());
  await refreshDataQuality();
}

export async function refreshDataQuality() {
  const body = $('dataQualityBody');
  let data;
  try {
    data = await api('/api/data-quality');
  } catch (err) {
    body.textContent = '';
    body.append(el('div', { class: 'st-blocked', role: 'alert', text: err.message }));
    return;
  }
  render(body, data);
  schedulePoll(data.enrichment?.state);
}

function schedulePoll(status) {
  clearTimeout(pollTimer);
  if (status?.running && dialog()?.open) pollTimer = setTimeout(pollEnrichment, 2000);
}

async function pollEnrichment() {
  if (!dialog()?.open) return;
  let status;
  try { status = await api('/api/enrichment'); } catch { return; }
  // Finished: re-read everything, since the counts have moved.
  if (!status.running) { await refreshDataQuality(); return; }
  const host = $('dqProgress');
  if (host) host.replaceChildren(...progressNodes(status));
  schedulePoll(status);
}

function stat(label, value, hint) {
  return el('div', { class: 'dq-stat', title: hint ?? '' },
    el('b', { text: fmt(value) }), el('span', { class: 'muted', text: label }));
}

function render(body, data) {
  body.textContent = '';
  if (data.settingsError) body.append(el('div', { class: 'st-blocked', role: 'alert', text: data.settingsError }));

  const filteredTotal = data.filtered.reduce((n, f) => n + f.count, 0);
  body.append(el('section', { class: 'pf-section', 'aria-labelledby': 'dqOverview' },
    el('h3', { id: 'dqOverview', text: 'Your job store' }),
    el('div', { class: 'dq-stats' },
      stat('scored and on your board', data.board.scored),
      stat('waiting for a description', data.board.needsDescription,
        'Found, but only a summary was read, so fit cannot be judged yet.'),
      stat('filtered out', filteredTotal, 'See "Why jobs were filtered" below.'),
      data.board.dateReview ? stat('held: no posting date', data.board.dateReview) : null)));

  body.append(freshnessSection(data.freshness));
  body.append(enrichmentSection(data.enrichment));
  body.append(filteredSection(data.filtered));
  body.append(sourcesSection(data.sourceProblems, data.enrichment?.backlog));
}

function freshnessSection(f) {
  const select = el('select', { id: 'dqWindow', name: 'discoveryWindow' },
    ...WINDOW_OPTIONS.map(([value, label]) => {
      const opt = el('option', { value, text: label });
      if (value === f.discoveryWindow) opt.selected = true;
      return opt;
    }));
  const retention = el('input', {
    id: 'dqRetention', name: 'retentionDays', type: 'number', inputmode: 'numeric',
    min: String(f.retentionRange.min), max: String(f.retentionRange.max), step: '1', value: String(f.retentionDays),
  });
  return el('section', { class: 'pf-section', 'aria-labelledby': 'dqFresh' },
    el('h3', { id: 'dqFresh', text: 'How long jobs stay' }),
    el('ul', { class: 'dq-rules' }, ...f.rules.map((r) => el('li', { text: r }))),
    el('form', { class: 'dq-form', 'data-submit': 'save-freshness' },
      el('label', { for: 'dqWindow', text: 'Add new jobs posted within' }), select,
      el('span', { class: 'faint fineprint', text: SOURCE_NOTE[f.sources?.discoveryWindow] ?? '' }),
      el('label', { for: 'dqRetention', text: 'Retire jobs older than (days)' }), retention,
      el('span', { class: 'faint fineprint', text: SOURCE_NOTE[f.sources?.retentionDays] ?? '' }),
      el('div', { class: 'row-gap dq-form-actions' },
        el('button', { type: 'submit', class: 'small primary', text: 'Save' }),
        el('span', { class: 'faint fineprint', text: 'Saved to data/settings.json. Jobs on the board are re-checked right away; a wider window affects the next search.' }))));
}

function progressNodes(status) {
  const p = status?.progress;
  const nodes = [];
  if (status?.running && p) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    nodes.push(el('div', { role: 'status', 'aria-live': 'polite', text: status.stopping
      ? `Stopping after the current request… ${fmt(p.done)} of ${fmt(p.total)} read`
      : `Reading descriptions: ${fmt(p.done)} of ${fmt(p.total)} · ${fmt(p.fetched)} read · ${fmt(p.failed)} failed · ${fmt(p.nowActionable)} now worth a look` }));
    const fill = el('i');
    fill.style.width = `${pct}%`;
    nodes.push(el('div', {
      class: 'bar', role: 'progressbar', 'aria-label': 'Description fetching progress',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
    }, fill));
  } else if (status?.running) {
    nodes.push(el('div', { role: 'status', text: 'Starting…' }));
  } else if (status?.last) {
    const l = status.last;
    nodes.push(el('div', { class: l.error ? 'st-blocked' : 'muted', text: l.error
      ? `Last pass failed: ${l.error}`
      : `Last pass ${shortStamp(l.finishedAt)}${l.cancelled ? ' (stopped early)' : ''}: ${fmt(l.fetched)} read, `
        + `${fmt(l.failed)} failed${l.gone ? ` (${fmt(l.gone)} postings gone)` : ''}, ${fmt(l.nowActionable)} now worth a look, `
        + `${fmt(l.stillWeak)} read and weak, ${fmt(l.excluded)} excluded once read.` }));
  }
  return nodes;
}

function enrichmentSection(e) {
  const b = e.backlog ?? {};
  const s = e.state ?? {};
  const toggle = el('input', {
    type: 'checkbox', id: 'dqEnrichOn', 'data-action': 'toggle-enrichment',
    'aria-describedby': 'dqEnrichHint',
  });
  toggle.checked = e.settings?.enabled === true;
  return el('section', { class: 'pf-section', 'aria-labelledby': 'dqEnrich' },
    el('h3', { id: 'dqEnrich', text: 'Missing descriptions' }),
    el('p', { class: 'muted', id: 'dqEnrichHint', text:
      'Some job boards list a job without its description, so its fit cannot be judged. '
      + 'JobAgent can read those descriptions from the same public pages, a few at a time. '
      + 'Jobs you shortlisted, prepared or applied to are never changed.' }),
    el('label', { class: 'toggle', for: 'dqEnrichOn' }, toggle,
      el('span', { text: `Read missing descriptions in the background (every ${e.settings?.intervalHours ?? 6} h, up to ${fmt(e.settings?.maxPerPass)} per pass)` })),
    el('div', { class: 'dq-stats' },
      stat('ready to read now', b.readyNow, 'Active jobs whose title fits your search, inside retention, on a readable source.'),
      stat('failed recently, retried later', b.coolingDown),
      stat('given up on', b.gaveUp, 'Failed repeatedly, or the posting is gone.'),
      stat('on sources that cannot be read', b.unsupported)),
    el('div', { id: 'dqProgress', class: 'dq-progress' }, ...progressNodes(s)),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'small primary', 'data-action': 'enrichment-start',
        disabled: s.running || !b.readyNow ? true : null, text: 'Read descriptions now' }),
      s.running ? el('button', { type: 'button', class: 'small', 'data-action': 'enrichment-stop', text: 'Stop' }) : null));
}

function filteredSection(filtered) {
  return el('section', { class: 'pf-section', 'aria-labelledby': 'dqWhy' },
    el('h3', { id: 'dqWhy', text: 'Why jobs were filtered' }),
    el('p', { class: 'muted', text: 'Every job JobAgent found and did not put on your board, grouped by the rule that removed it.' }),
    miniTable(['Reason', 'Jobs', 'What it means'], filtered.map((f) => [
      f.label, fmt(f.count), f.action ? `${f.explain} ${f.action}` : f.explain,
    ])));
}

function sourcesSection(problems, backlog) {
  const rows = (problems?.sources ?? []).map((s) => [
    s.source, s.failed ? 'failed' : `${fmt(s.errors)} error(s)`, fmt(s.found), s.message ?? '—',
  ]);
  const unread = Object.entries(backlog?.bySource ?? {}).sort((a, b) => b[1] - a[1]);
  return el('section', { class: 'pf-section', 'aria-labelledby': 'dqSrc' },
    el('h3', { id: 'dqSrc', text: 'Source problems' }),
    el('p', { class: 'muted', text: problems?.runAt
      ? `From the last search (${shortStamp(problems.runAt)}).`
      : 'No search has recorded per-source results yet.' }),
    rows.length ? miniTable(['Source', 'Result', 'Jobs found', 'What happened'], rows)
      : el('div', { class: 'muted', text: 'Every source answered in the last search.' }),
    unread.length ? el('h3', { text: 'Waiting for a description, by source' }) : null,
    unread.length ? miniTable(['Source', 'Jobs'], unread.map(([src, n]) => [src, fmt(n)])) : null);
}

/* ───────────────────────────── actions ───────────────────────────── */

export async function saveFreshness(button) {
  const discoveryWindow = $('dqWindow')?.value;
  const retentionDays = Number($('dqRetention')?.value);
  await withBusy(button, async () => {
    try {
      const out = await postJson('/api/settings', { discoveryWindow, retentionDays });
      toast(out.warning ?? 'Saved. Jobs on your board are being re-checked.', out.warning ? 'bad' : 'good');
      await refreshDataQuality();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

export async function toggleEnrichment(target) {
  const enabled = target.checked === true;
  try {
    await postJson('/api/settings', { enrichment: { enabled } });
    toast(enabled
      ? 'Background description reading is on. Use "Read descriptions now" to start straight away.'
      : 'Background description reading is off.', 'good');
  } catch (err) {
    target.checked = !enabled;
    toast(err.message, 'bad');
  }
}

export async function startEnrichment(button) {
  await withBusy(button, async () => {
    try {
      await postJson('/api/enrichment/start');
      await refreshDataQuality();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

export async function stopEnrichment(button) {
  await withBusy(button, async () => {
    try {
      await postJson('/api/enrichment/stop');
      toast('Stopping after the requests already in flight. Everything read so far is kept.');
      await pollEnrichment();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}
