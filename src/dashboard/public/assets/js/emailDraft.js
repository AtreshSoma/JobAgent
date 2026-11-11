/**
 * "Email these jobs": turn the jobs on the board into an email draft.
 *
 * Pure: no DOM, no fetch. The dialog (emailJobs.js) gathers the jobs and wires
 * the buttons; everything that decides what the email SAYS lives here, so it
 * is tested directly.
 *
 * Job titles, companies and locations are scraped from employers' pages, so
 * they are untrusted text: every one is HTML-escaped, and a posting link is
 * only made clickable when it is a plain http(s) URL.
 */

/** Most jobs one draft carries; a longer list stops being readable as email. */
export const EMAIL_MAX_JOBS = 500;

/**
 * Longest mailto: link offered. Outlook on Windows and several webmail
 * handlers cut longer ones off silently, losing jobs from the end of the list.
 */
export const MAILTO_MAX = 2000;

const LOCATION_MAX = 80;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One line of plain text: no newlines or runs of spaces from scraped markup. */
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** The posting URL, only when it is an absolute http(s) link. */
export function safePostingUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function formatDate(value, { withYear = true, weekday = false } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), ...(weekday ? { weekday: 'short' } : {}),
  });
}

/** One job, reduced to what the email shows. */
export function emailItem(job) {
  const title = oneLine(job?.title) || 'Untitled role';
  const company = oneLine(job?.company);
  const location = clip(oneLine(job?.location), LOCATION_MAX);
  const remote = job?.remote === true && !/\bremote\b/i.test(location);
  const posted = job?.postedAt ? formatDate(job.postedAt) : '';
  const score = Number.isFinite(Number(job?.score)) && job?.score !== null && job?.score !== ''
    ? Math.round(Number(job.score)) : null;
  const details = [
    location,
    remote ? 'Remote' : '',
    posted ? `Posted ${posted}` : '',
    score !== null ? `Fit ${score}/100` : '',
  ].filter(Boolean);
  return { title, company, details, url: safePostingUrl(job?.url) };
}

/**
 * The draft for `jobs`, in the order given (the board's order).
 *
 * @param {object[]} jobs
 * @param {{ scope?: string, filters?: string[], total?: number, now?: Date }} [options]
 *   scope: what the list is, e.g. "matching your filters" or "3 selected jobs".
 *   filters: the active filter labels, shown so the reader knows what was searched.
 *   total: how many jobs matched, when more matched than `jobs` holds.
 */
export function buildJobEmail(jobs, { scope = '', filters = [], total, now = new Date() } = {}) {
  const items = (jobs ?? []).slice(0, EMAIL_MAX_JOBS).map(emailItem);
  const count = items.length;
  const noun = count === 1 ? 'job posting' : 'job postings';
  const day = formatDate(now, { weekday: true });
  const subject = `${count} ${noun} from JobAgent (${formatDate(now)})`;

  const intro = `${count} ${noun} from JobAgent${scope ? `, ${scope}` : ''}, as of ${day}.`;
  const filterLine = filters.length ? `Filters: ${filters.map(oneLine).join(' · ')}` : '';
  const more = Number(total) > count
    ? `This is the first ${count.toLocaleString('en-US')} of ${Number(total).toLocaleString('en-US')} matching jobs, in the order the board shows them.`
    : '';

  const textLines = [intro];
  if (filterLine) textLines.push(filterLine);
  if (more) textLines.push(more);
  textLines.push('');
  items.forEach((item, i) => {
    textLines.push(`${i + 1}. ${item.title}${item.company ? ` at ${item.company}` : ''}`);
    if (item.details.length) textLines.push(`   ${item.details.join(' · ')}`);
    textLines.push(`   ${item.url ?? '(no public link)'}`);
    textLines.push('');
  });
  textLines.push('Shared from JobAgent.');
  const text = textLines.join('\n');

  const muted = 'color:#5f6b7a';
  const htmlItems = items.map((item) => {
    const title = item.url
      ? `<a href="${escapeHtml(item.url)}" style="font-weight:600;color:#1a56db;text-decoration:none">${escapeHtml(item.title)}</a>`
      : `<span style="font-weight:600">${escapeHtml(item.title)}</span> <span style="${muted}">(no public link)</span>`;
    const company = item.company ? ` <span style="${muted}">at</span> ${escapeHtml(item.company)}` : '';
    const details = item.details.length
      ? `<br><span style="${muted};font-size:13px">${item.details.map(escapeHtml).join(' · ')}</span>`
      : '';
    return `<li style="margin:0 0 12px">${title}${company}${details}</li>`;
  }).join('');
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2933">',
    `<p style="margin:0 0 4px">${escapeHtml(intro)}</p>`,
    filterLine ? `<p style="margin:0 0 4px;${muted}">${escapeHtml(filterLine)}</p>` : '',
    more ? `<p style="margin:0 0 4px;${muted}">${escapeHtml(more)}</p>` : '',
    `<ol style="margin:12px 0 16px;padding-left:22px">${htmlItems}</ol>`,
    `<p style="margin:0;${muted};font-size:12px">Shared from JobAgent.</p>`,
    '</div>',
  ].join('');

  return { subject, text, html, items, count, linked: items.filter((item) => item.url).length };
}

/** A header value with no line breaks, so it cannot start a second header. */
const headerValue = (value) => oneLine(value);

/** Comma-separated addresses, with stray separators and spaces removed. */
export function cleanRecipients(value) {
  return headerValue(value).split(/[,;]/).map((part) => part.trim()).filter(Boolean).join(', ');
}

/** A mailto: link for the draft, or null when it would be too long to arrive whole. */
export function mailtoHref({ to = '', subject = '', text = '' } = {}) {
  const recipients = cleanRecipients(to).split(', ').filter(Boolean).map(encodeURIComponent).join(',');
  // RFC 6068: line breaks in a mailto body are CRLF.
  const body = encodeURIComponent(String(text).replace(/\r?\n/g, '\r\n'));
  const href = `mailto:${recipients}?subject=${encodeURIComponent(headerValue(subject))}&body=${body}`;
  return href.length <= MAILTO_MAX ? href : null;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const wrap76 = (value) => value.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/** RFC 2047 encoded-words for a header that is not plain ASCII. */
function encodeHeader(value) {
  const text = headerValue(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = '';
  for (const ch of text) {
    // ~45 UTF-8 bytes keeps each encoded word under the 75-character limit.
    if (new TextEncoder().encode(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64Utf8(word)}?=`).join('\r\n ');
}

/**
 * The draft as an .eml file. `X-Unsent: 1` makes Outlook (Windows and Mac)
 * and Thunderbird open it as a new message ready to edit and send; Apple Mail
 * opens it as a message you can forward or "Send Again".
 */
export function emlFile({ to = '', subject = '', text = '', html = '', now = new Date(), boundary } = {}) {
  const b = boundary ?? `jobagent-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const recipients = cleanRecipients(to);
  const lines = [
    'X-Unsent: 1',
    ...(recipients ? [`To: ${recipients}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Utf8(text)),
    `--${b}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Utf8(`<!doctype html><html><body>${html}</body></html>`)),
    `--${b}--`,
    '',
  ];
  return lines.join('\r\n');
}

/** A file name for the draft: "job-postings-2026-11-10.eml". */
export function emlFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `job-postings-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.eml`;
}
