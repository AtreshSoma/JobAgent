/** The Reports and Resume library dialogs. */

import { $, el, shortStamp, slowProgress } from './dom.js';
import { api } from './api.js';
import { openDialog } from './dialogs.js';
import { kb } from './master.js';

/* ─────────────────────── reports + library ─────────────────────── */

export function miniTable(headers, rows) {
  if (!rows.length) return el('div', { class: 'muted', text: 'None.' });
  const table = el('table', { class: 'minitable' });
  table.append(el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))));
  const tbody = el('tbody');
  for (const row of rows) {
    tbody.append(el('tr', {}, ...row.map((cell) => (
      cell?.nodeType ? el('td', {}, cell) : el('td', { text: String(cell ?? '—') })
    ))));
  }
  table.append(tbody);
  return table;
}

export async function openReports() {
  const body = $('reportsBody');
  const stop = slowProgress(body, 'Building the report — reading the whole database…');
  openDialog($('dlgReports'));

  let report;
  try { report = await api('/api/reports'); }
  catch (err) { stop(); body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }
  stop();

  const totals = report.dailySummary.totals;
  body.textContent = '';
  body.append(el('div', { class: 'actions' },
    el('button', { class: 'small', 'data-action': 'export-jobs', text: '⬇ All jobs + scores' }),
    el('button', { class: 'small', 'data-action': 'export-tracker', text: '⬇ Application tracker' })));

  body.append(el('h3', { text: 'Today' }));
  body.append(el('div', { class: 'muted', text:
    `${totals.discoveredToday} found · ${totals.preparedToday} prepared · ${totals.submittedToday} submitted `
    + `· ${totals.pendingReview} awaiting review · ${totals.blocked} need you` }));

  body.append(el('h3', { text: 'Daily summary' }));
  body.append(miniTable(['Day', 'Found', 'Prepared', 'Submitted'],
    report.dailySummary.daily.map((d) => [d.day, d.discovered, d.prepared, d.submitted])));

  body.append(el('h3', { text: `Application log (${report.applicationLog.length})` }));
  body.append(miniTable(['Job', 'Status', 'When', 'Confirmation', 'Blockers'],
    report.applicationLog.slice(0, 200).map((r) => [
      `${r.company} — ${r.title}`, String(r.appStatus).replace(/_/g, ' '),
      shortStamp(r.appliedAt) || '—', r.confirmation ?? '—',
      (r.blockers ?? []).join('; ') || '—',
    ])));

  body.append(el('h3', { text: `Prepared packets awaiting action (${report.preparedPackets.length})` }));
  body.append(miniTable(['Job', 'Grade', 'Sponsorship', 'Status'],
    report.preparedPackets.map((r) => [
      `${r.company} — ${r.title}`, r.grade?.letter ?? '—', r.sponsorship ?? '—',
      String(r.appStatus).replace(/_/g, ' '),
    ])));

  body.append(el('h3', { text: 'Source performance' }));
  body.append(miniTable(['Source', 'Found', 'Strong', 'Strong rate', 'Prepared', 'Submitted'],
    report.sourcePerformance.map((s) => [s.source, s.found, s.strong, `${s.strongRate}%`, s.prepared, s.submitted])));

  body.append(el('h3', { text: 'Sponsorship summary' }));
  body.append(miniTable(['Confidence', 'Jobs', 'Strong fit'],
    report.sponsorshipSummary.map((s) => [s.confidence, s.jobs, s.strongFit])));
}

export async function openDocuments() {
  const body = $('documentsBody');
  body.textContent = '';
  body.append(el('div', { class: 'skeleton' }));
  openDialog($('dlgDocuments'));

  let docs;
  try { docs = await api('/api/documents'); }
  catch (err) { body.textContent = ''; body.append(el('div', { class: 'st-blocked', text: err.message })); return; }

  body.textContent = '';
  if (docs.master) {
    body.append(el('h3', { text: 'Master resume' }));
    const row = el('div', { class: 'row-gap' });
    row.append(el('span', {
      class: docs.master.exists ? 'muted' : 'st-blocked',
      text: docs.master.exists
        ? `${kb(docs.master.bytes)}, updated ${shortStamp(docs.master.modifiedAt)}`
        : 'NOT FOUND — tailoring cannot run without it',
    }));
    row.append(el('button', {
      class: 'small', 'data-action': 'open-master',
      text: docs.master.exists ? 'View / replace…' : 'Upload it…',
    }));
    body.append(row);
    body.append(el('div', { class: 'mr-path', text: docs.master.path }));
  }
  body.append(el('h3', { text: `Tailored versions (${docs.tailored.length})` }));
  if (!docs.tailored.length) {
    body.append(el('div', { class: 'muted', text: 'No tailored resumes yet — prepare a job to generate one.' }));
    return;
  }
  body.append(miniTable(['Job', 'Prepared', 'ATS', 'Updates', 'Gaps', 'Open'],
    docs.tailored.slice(0, 200).map((d) => [
      `${d.company} — ${d.title}`,
      shortStamp(d.preparedAt) || '—',
      d.atsScore != null ? `${d.atsScore}%` : '—',
      d.tailoring?.changeCount ?? '—',
      d.tailoring?.gapCount ?? '—',
      el('button', { class: 'small', 'data-action': 'preview-resume', 'data-id': d.jobId, text: '👁 View' }),
    ])));
}
