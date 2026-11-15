/**
 * Years of experience with a skill, worked out from dated work history
 * (audit A6).
 *
 * A qualified question ("How many years of experience do you have with X?")
 * must never be answered with a career total. The honest number is the time
 * spent in roles that actually mention X. This works it out and says which
 * roles it used, so the person can check it. It only ever SUGGESTS: nothing
 * here answers a form. A number is used on forms after the person confirms it
 * and it is saved as `skillExperience` (see answerScreeningQuestion).
 *
 * Rules that keep it from overstating:
 *   - a role counts only if its title or highlights name the skill as a whole
 *     word ("Java" is not found in "JavaScript");
 *   - overlapping roles are counted once;
 *   - a date given only as a year is read conservatively (a start as December,
 *     an end as January), so the figure is never longer than the truth;
 *   - the result is rounded DOWN to whole years;
 *   - a role whose dates cannot be read adds nothing.
 */
import { normalizeText, wholeWordIn } from '../utils/textNormalize.js';

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PRESENT_RE = /^(?:present|current|now|today|ongoing|to date)$/i;

/**
 * A month index (year * 12 + month) for a resume date, or null.
 * @param {unknown} text "January 2020", "Jan 2020", "01/2020", "2020-01", "2020"
 * @param {'start'|'end'} edge which end of a role it is, for a year-only date
 */
export function monthIndex(text, edge = 'start') {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const year = /\b((?:19|20)\d{2})\b/.exec(raw)?.[1];
  if (!year) return null;
  const y = Number(year);
  const named = MONTH_NAMES.findIndex((m) => new RegExp(`\\b${m}[a-z]*\\b`, 'i').test(raw));
  if (named >= 0) return y * 12 + named;
  const numeric = /\b(0?[1-9]|1[0-2])\s*[/.-]\s*(?:19|20)\d{2}\b/.exec(raw) ?? /\b(?:19|20)\d{2}\s*[/.-]\s*(0?[1-9]|1[0-2])\b/.exec(raw);
  if (numeric) return y * 12 + (Number(numeric[1]) - 1);
  // Year only: the shorter reading.
  return y * 12 + (edge === 'start' ? 11 : 0);
}

function rolesText(role) {
  return normalizeText([role?.title, ...(Array.isArray(role?.highlights) ? role.highlights : [])].join(' \n '));
}

/**
 * @param {string} subject the skill, as the question names it
 * @param {object[]} workHistory candidate.workHistory
 * @param {{now?: Date}} [options]
 * @returns {{answer: string, months: number, roles: object[], note: string}|null}
 */
export function skillYearsFromHistory(subject, workHistory = [], { now = new Date() } = {}) {
  const want = normalizeText(subject);
  if (!want || !Array.isArray(workHistory)) return null;
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();

  const used = [];
  for (const role of workHistory) {
    if (!wholeWordIn(rolesText(role), want)) continue;
    const start = monthIndex(role.startDate, 'start');
    if (start === null) continue;
    const endText = String(role.endDate ?? '').trim();
    const open = role.current === true || PRESENT_RE.test(endText) || (!endText && role.current !== false);
    const end = open ? nowIndex : monthIndex(endText, 'end');
    if (end === null || end <= start) continue;
    used.push({
      employer: String(role.employer ?? ''), title: String(role.title ?? ''),
      start: String(role.startDate ?? ''), end: open ? 'Present' : endText, from: start, to: Math.min(end, nowIndex),
    });
  }
  if (!used.length) return null;

  // Union of the intervals, so overlapping roles count once.
  const spans = used.map((u) => [u.from, u.to]).sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [curStart, curEnd] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else { months += curEnd - curStart; [curStart, curEnd] = [s, e]; }
  }
  months += curEnd - curStart;
  if (months <= 0) return null;

  const years = Math.floor(months / 12);
  const answer = years < 1 ? 'Less than 1 year' : `${years} year${years === 1 ? '' : 's'}`;
  return {
    answer,
    months,
    roles: used.map(({ employer, title, start, end }) => ({ employer, title, start, end })),
    note: 'Counted from roles that mention it, overlaps once, rounded down. A date with only a year is read conservatively.',
  };
}
