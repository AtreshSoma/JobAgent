/**
 * The "Email these jobs" dialog: gathers the jobs the board is showing (or the
 * selected ones), previews the draft, and hands it to the user's email three
 * ways — copy (pastes with clickable links into Gmail, Outlook or Apple Mail),
 * open in the default mail app, or download an .eml draft.
 *
 * Nothing is sent from here. The user's own mail app sends, if they choose to.
 */

import { $, el, toast } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { activeFilterChips, filterParams, TABS } from './filters.js';
import { selectedJobs } from './selection.js';
import { openDialog } from './dialogs.js';
import {
  buildJobEmail, EMAIL_MAX_JOBS, emlFile, emlFileName, mailtoHref,
} from './emailDraft.js';

/** How many jobs the dialog previews; the email itself carries all of them. */
const PREVIEW_MAX = 60;

let draft = null;
let draftAt = new Date();

/**
 * The jobs to email: the selection when there is one, else the board's
 * filtered list. `scope` is written for whoever READS the email (often a
 * friend, so never "your"); `where` tells the person in the dialog.
 */
async function gatherJobs() {
  if (state.selected.size) {
    const jobs = await selectedJobs();
    return { jobs, scope: 'hand-picked', where: 'you selected', filters: [] };
  }
  const params = filterParams();
  params.set('fields', 'board');
  params.set('limit', String(EMAIL_MAX_JOBS));
  params.set('page', '1');
  const page = await api(`/api/jobs?${params}`);
  const tab = state.activeTab && state.activeTab !== 'all'
    ? TABS.find(([key]) => key === state.activeTab)?.[1] : null;
  const filters = activeFilterChips().map(([, label]) => label);
  return {
    jobs: page.jobs ?? [],
    total: page.total,
    scope: tab ? `from the ${tab} list` : '',
    where: tab ? `in ${tab}` : filters.length ? 'matching your filters' : 'from your Jobs board',
    filters,
  };
}

export async function openEmailJobs() {
  let gathered;
  try {
    gathered = await gatherJobs();
  } catch (err) {
    toast(`Could not gather the jobs: ${err.message}`, 'bad');
    return;
  }
  if (!gathered.jobs.length) {
    toast('There are no jobs on the board to email. Clear a filter or find jobs first.');
    return;
  }
  draftAt = new Date();
  draft = buildJobEmail(gathered.jobs, {
    scope: gathered.scope, filters: gathered.filters, total: gathered.total, now: draftAt,
  });

  $('emailSubject').value = draft.subject;
  const unlinked = draft.count - draft.linked;
  const parts = [`${draft.count.toLocaleString('en-US')} ${draft.count === 1 ? 'job' : 'jobs'} ${gathered.where}`];
  if (Number(gathered.total) > draft.count) parts.push(`the first ${draft.count.toLocaleString('en-US')} of ${Number(gathered.total).toLocaleString('en-US')}`);
  if (unlinked) parts.push(`${unlinked} without a public link`);
  $('emailScope').textContent = `${parts.join(' · ')}.`;
  $('emailStatus').textContent = '';
  renderPreview(draft.items);
  syncMailto();
  openDialog($('dlgEmail'));
}

function renderPreview(items) {
  const host = $('emailPreview');
  host.textContent = '';
  const list = el('ol', { class: 'email-list' });
  for (const item of items.slice(0, PREVIEW_MAX)) {
    const title = item.url
      ? el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', text: item.title })
      : el('span', { class: 'email-nolink', text: `${item.title} (no public link)` });
    list.append(el('li', {},
      title,
      item.company ? el('span', { class: 'email-co', text: ` at ${item.company}` }) : '',
      item.details.length ? el('div', { class: 'email-meta', text: item.details.join(' · ') }) : ''));
  }
  host.append(list);
  if (items.length > PREVIEW_MAX) {
    host.append(el('p', { class: 'muted email-more', text: `…and ${items.length - PREVIEW_MAX} more in the email.` }));
  }
}

const currentSubject = () => $('emailSubject').value.trim() || draft?.subject || '';

/** Enable "Open in email app" only when the whole list fits in a mail link. */
function syncMailto() {
  if (!draft) return;
  const href = mailtoHref({ to: $('emailTo').value, subject: currentSubject(), text: draft.text });
  const button = $('emailOpenBtn');
  button.disabled = !href;
  $('emailMailtoNote').hidden = Boolean(href);
}

document.addEventListener('input', (event) => {
  if (event.target?.id === 'emailTo' || event.target?.id === 'emailSubject') syncMailto();
});

function done(message) {
  $('emailStatus').textContent = message;
  toast(message, 'good');
}

/** Copy as rich text (links stay clickable when pasted) with a plain-text twin. */
export async function copyEmail() {
  if (!draft) return;
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('rich clipboard unavailable');
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([draft.html], { type: 'text/html' }),
      'text/plain': new Blob([draft.text], { type: 'text/plain' }),
    })]);
  } catch {
    try {
      await navigator.clipboard.writeText(draft.text);
    } catch {
      const area = el('textarea', {});
      area.value = draft.text;
      $('dlgEmail').append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }
  done('Copied. Paste it into a new email in Gmail, Outlook or Apple Mail.');
}

export function openInMailApp() {
  if (!draft) return;
  const href = mailtoHref({ to: $('emailTo').value, subject: currentSubject(), text: draft.text });
  if (!href) {
    toast('This list is too long for a mail link. Use Copy email or Download draft instead.', 'bad');
    return;
  }
  const link = el('a', { href });
  document.body.append(link);
  link.click();
  link.remove();
  $('emailStatus').textContent = 'Opened your email app with the draft.';
}

export function downloadEmailDraft() {
  if (!draft) return;
  const file = emlFile({ to: $('emailTo').value, subject: currentSubject(), text: draft.text, html: draft.html, now: draftAt });
  const href = URL.createObjectURL(new Blob([file], { type: 'message/rfc822' }));
  const name = emlFileName(draftAt);
  const link = el('a', { href, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  done(`Downloaded ${name}. Open it to edit and send from your email app.`);
}
