/**
 * Setup progress: the template-value check, grouped by where each value is fixed.
 *
 * WHY. `findPlaceholders` reports one entry per stored copy of a fact. A fresh
 * profile had 19 of them, and the dashboard listed every one, each with the same
 * instruction: the name twice (full and preferred), work authorization four
 * times (two candidate fields, two answers and the cover-letter sentence all
 * read from the same answer), years of experience twice. It filled the first
 * screen and told the person to run a CLI command.
 *
 * WHAT. A fixed list of the things a person actually fills in, each owning the
 * detector paths it fixes. The list is the denominator ("7 of 13 done"); the
 * detector decides which are still pending. Nothing here decides whether
 * applying is allowed: that is still `findPlaceholders(...).ok`, unchanged, and
 * `setupProgress(...).ok` is the same boolean.
 *
 * Work authorization, sponsorship and salary are `personOnly`: the card never
 * offers to fill them from the resume, and no code here produces a value.
 */
import { findPlaceholders } from './placeholders.js';

/** The groups, in the order the card shows them. */
export const SETUP_GROUPS = Object.freeze([
  { key: 'contact', title: 'Contact' },
  { key: 'authorization', title: 'Work authorization and sponsorship' },
  { key: 'experience', title: 'Experience' },
  { key: 'screening', title: 'Screening answers' },
]);

const answerPath = (id) => `answers[id=${id}].answer`;

/**
 * Each item a person fills in once, the detector paths it covers, and where it
 * is fixed. `fix.editor` is 'details' (Application profile → Your details, by
 * `data-path`) or 'answers' (Saved answers, by answer id); `fix.action` names a
 * one-click fix offered beside the editor.
 */
export const SETUP_ITEMS = Object.freeze([
  { key: 'fullName', group: 'contact', label: 'Name', paths: ['identity.fullName'], fix: { editor: 'details', field: 'identity.fullName' } },
  { key: 'preferredName', group: 'contact', label: 'Preferred name', paths: ['identity.preferredName'], fix: { editor: 'details', field: 'identity.preferredName' } },
  { key: 'email', group: 'contact', label: 'Email', paths: ['contact.email'], fix: { editor: 'details', field: 'contact.email' } },
  { key: 'phone', group: 'contact', label: 'Phone', paths: ['contact.phone'], fix: { editor: 'details', field: 'contact.phone' } },
  { key: 'city', group: 'contact', label: 'City', paths: ['location.city'], fix: { editor: 'details', field: 'location.city' } },
  { key: 'state', group: 'contact', label: 'State', paths: ['location.state'], fix: { editor: 'details', field: 'location.state' } },
  { key: 'zip', group: 'contact', label: 'ZIP code', paths: ['location.zip'], fix: { editor: 'details', field: 'location.zip' } },
  { key: 'linkedin', group: 'contact', label: 'LinkedIn', paths: ['identity.links.linkedin'], fix: { editor: 'details', field: 'identity.links.linkedin' } },
  {
    key: 'authorization',
    group: 'authorization',
    label: 'Work authorization and sponsorship',
    // One answer fills the candidate's status and details and the letter's
    // sponsorship sentence (src/config/answerFallbacks.js); sponsorship is its own answer.
    paths: [/^workAuthorization\./, answerPath('work_authorization'), answerPath('require_sponsorship'), 'template.sponsorshipNote'],
    answers: ['work_authorization', 'require_sponsorship'],
    fix: { editor: 'answers', field: 'work_authorization' },
    personOnly: true,
  },
  {
    key: 'yearsExperience',
    group: 'experience',
    label: 'Years of experience',
    // The cover letter's copy is filled from the answer.
    paths: [answerPath('years_experience'), 'yearsOfExperience'],
    fix: { editor: 'answers', field: 'years_experience' },
  },
  {
    key: 'background',
    group: 'experience',
    label: 'Work history and education',
    paths: [/^workHistory\[/, /^education\[/],
    fix: { action: 'fill-profile-from-resume', label: 'Fill from my resume' },
  },
  { key: 'salary', group: 'screening', label: 'Salary expectation', paths: [answerPath('salary_expectation')], fix: { editor: 'answers', field: 'salary_expectation' }, personOnly: true },
  { key: 'startDate', group: 'screening', label: 'Start date', paths: [answerPath('start_date')], fix: { editor: 'answers', field: 'start_date' } },
]);

const ANSWER_PATH_RE = /^answers\[id=([^\]]+)\]\.answer$/;

/**
 * The setup item that owns one detector path, or null when none does.
 *
 * @param {string} path a `path` from findPlaceholders
 * @returns {object|null}
 */
export function itemForPath(path = '') {
  return SETUP_ITEMS.find((item) => item.paths.some((p) => (p instanceof RegExp ? p.test(path) : p === path))) ?? null;
}

/**
 * A pending item for a detector path no fixed item owns. A saved answer the
 * person added themselves still holding "YOUR ..." text lands here, so it is
 * shown and still holds applying, instead of vanishing from the count.
 */
function extraItem(path) {
  const id = ANSWER_PATH_RE.exec(path)?.[1];
  if (id) {
    const label = id.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    return { key: `answer:${id}`, group: 'screening', label, paths: [path], fix: { editor: 'answers', field: id } };
  }
  return { key: `path:${path}`, group: 'contact', label: path, paths: [path], fix: { editor: 'details', field: path } };
}

/**
 * Setup progress for one configuration bundle.
 *
 * @param {object} config loadConfig() bundle (candidate, screeningAnswers, coverLetter)
 * @returns {{
 *   ok: boolean, total: number, done: number,
 *   groups: Array<{key: string, title: string, total: number, done: number, items: object[]}>
 * }}
 */
export function setupProgress(config = {}) {
  const found = findPlaceholders(config);
  const pending = new Map();
  const extras = new Map();
  for (const hit of found.placeholders) {
    const item = itemForPath(hit.path) ?? extras.get(hit.path) ?? extraItem(hit.path);
    if (!itemForPath(hit.path)) extras.set(hit.path, item);
    const list = pending.get(item.key) ?? [];
    list.push(hit);
    pending.set(item.key, list);
  }

  const groups = SETUP_GROUPS.map((group) => {
    const items = [...SETUP_ITEMS, ...extras.values()]
      .filter((item) => item.group === group.key)
      .map((item) => describe(item, pending.get(item.key) ?? []));
    return { ...group, total: items.length, done: items.filter((i) => i.done).length, items };
  }).filter((group) => group.total > 0);

  const total = groups.reduce((n, g) => n + g.total, 0);
  const done = groups.reduce((n, g) => n + g.done, 0);
  return { ok: found.ok, total, done, groups };
}

/** One item for the card: done or not, what it still says, and where it is fixed. */
function describe(item, hits) {
  let fix = { ...item.fix };
  // Open the first answer that is still template text, not always the first answer.
  if (item.answers && hits.length) {
    const firstOpen = item.answers.find((id) => hits.some((h) => h.path === answerPath(id)));
    if (firstOpen) fix = { ...fix, field: firstOpen };
  }
  // Several stored copies often hold the same template text; show it once.
  const values = [...new Set(hits.map((h) => h.value))];
  return {
    key: item.key,
    label: item.label,
    done: hits.length === 0,
    values,
    fix,
    personOnly: item.personOnly === true,
  };
}
