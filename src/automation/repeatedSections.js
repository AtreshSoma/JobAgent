/**
 * Work history and education: the repeated sections (audit A3).
 *
 * Workday's "My Experience" step, and the iCIMS and Taleo equivalents, ask for
 * one entry per job and per degree, each behind an "Add" button. They are
 * usually required, and auto-fill used to leave them to the person.
 *
 * For each role and degree in the profile this presses the section's "Add",
 * fills the entry that appears, and reads every value back.
 *
 * WHAT IT WILL NOT DO
 *   - Invent anything. Every value comes from `candidate.workHistory` and
 *     `candidate.education`; the role description is the profile's own
 *     highlights, one per line, unedited. An empty value stays empty.
 *   - Press any other "Add". Only a control that names a work-experience or
 *     education section is pressed ("Add Website", "Add attachment" and a
 *     bare "Add" outside such a section are not).
 *   - Add an entry twice. An entry whose employer or school already stands in
 *     a box on the page is left alone, so a resumed run does not duplicate.
 *   - Click in a dry run. It reports what it would add.
 *   - Loop. An "Add" that opens no fields is reported once and the section
 *     is left to the person.
 */
import { applicationFields, scanFields } from './domScanner.js';
import { monthIndex } from '../apply/skillYears.js';
import { normalizeText } from '../utils/textNormalize.js';

const MAX_WORK = 8;
const MAX_EDUCATION = 4;
const MAX_DESCRIPTION = 4000;

const SECTION_ADD = {
  work: /\badd\b[^.]{0,30}\b(?:work(?:\s+experience)?|employment|experience|job|position)\b/i,
  education: /\badd\b[^.]{0,30}\b(?:education|school|degree|university|college)\b/i,
};
const BARE_ADD = /^\s*add(?:\s+another)?\s*$/i;
const SECTION_HEADING = {
  work: /\b(?:work\s+experience|employment|work\s+history|experience)\b/i,
  education: /\b(?:education|school|degree)\b/i,
};

/** { month: 1-12 | null, year } for a resume date, or null ("Present", blank). */
export function parseResumeDate(text) {
  const raw = String(text ?? '').trim();
  if (!raw || /^(?:present|current|now|today|ongoing)$/i.test(raw)) return null;
  const idx = monthIndex(raw, 'start');
  if (idx === null) return null;
  const year = Math.floor(idx / 12);
  const hasMonth = /[a-z]{3}/i.test(raw) || /\b\d{1,2}\s*[/.-]\s*\d{4}\b/.test(raw) || /\b\d{4}\s*[/.-]\s*\d{1,2}\b/.test(raw);
  return { month: hasMonth ? (idx % 12) + 1 : null, year };
}

const two = (n) => String(n).padStart(2, '0');

/** What the profile says to type into each kind of box, or null to leave it. */
function workValues(role) {
  const start = parseResumeDate(role.startDate);
  const current = role.current === true || /^(?:present|current|now)$/i.test(String(role.endDate ?? '').trim());
  const end = current ? null : parseResumeDate(role.endDate);
  const highlights = (Array.isArray(role.highlights) ? role.highlights : []).map((h) => String(h).trim()).filter(Boolean);
  return {
    title: role.title, company: role.employer, location: role.location, current,
    startMonth: start?.month ? two(start.month) : null, startYear: start ? String(start.year) : null,
    endMonth: end?.month ? two(end.month) : null, endYear: end ? String(end.year) : null,
    startCombined: start ? (start.month ? `${two(start.month)}/${start.year}` : String(start.year)) : null,
    endCombined: end ? (end.month ? `${two(end.month)}/${end.year}` : String(end.year)) : null,
    description: highlights.join('\n').slice(0, MAX_DESCRIPTION) || null,
  };
}

function educationValues(entry) {
  return {
    school: entry.institution, degree: entry.degree, field: entry.field, gradYear: entry.graduationYear
      ? String(entry.graduationYear).trim() : null,
  };
}

/** Which value a box wants, from its label. First rule that matches wins. */
function workSlot(f) {
  const l = normalizeText(f.label);
  if (f.kind === 'checkbox') return /\b(?:currently|current(?:ly)?\s+(?:work|employ)|present|still\s+work)\b/.test(l) ? 'current' : null;
  if (/\b(?:description|responsibilit\w*|duties|summary|accomplishment\w*)\b/.test(l)) return 'description';
  const part = /\b(?:month|mm)\b/.test(l) ? 'Month' : /\b(?:year|yyyy)\b/.test(l) ? 'Year' : 'Combined';
  if (/\b(?:from|start(?:ed)?|begin)\b/.test(l)) return `start${part}`;
  if (/\b(?:to|end(?:ed)?|until)\b/.test(l) && /\b(?:month|mm|year|yyyy|date)\b|^to\b/.test(l)) return `end${part}`;
  if (/\b(?:job\s+title|position|title|role)\b/.test(l)) return 'title';
  if (/\b(?:company|employer|organi[sz]ation)\b/.test(l)) return 'company';
  if (/\b(?:location|city)\b/.test(l)) return 'location';
  return null;
}

function educationSlot(f) {
  const l = normalizeText(f.label);
  if (/\b(?:school|university|institution|college)\b/.test(l)) return 'school';
  if (/\b(?:field\s+of\s+study|major|discipline|area\s+of\s+study)\b/.test(l)) return 'field';
  if (/\b(?:degree|qualification|level\s+of\s+education)\b/.test(l)) return 'degree';
  if (/\b(?:graduat\w*|year\s+completed|end\s+year|completion)\b/.test(l)) return 'gradYear';
  return null;
}

/** Every visible, interactive control that is a candidate "Add" for a section. */
async function addControls(scope) {
  let handles;
  try { handles = await scope.locator('button, [role="button"], input[type="button"], a[role="button"]').all(); } catch { return []; }
  const found = [];
  for (const handle of handles) {
    let info;
    try {
      info = await handle.evaluate((el) => {
        const own = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\s+/g, ' ').trim();
        const box = el.closest('section, fieldset, [role="group"], [data-automation-id]');
        const heading = box?.querySelector('h1, h2, h3, h4, h5, legend, [role="heading"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const r = el.getBoundingClientRect();
        return { own, heading, visible: r.width > 0 && r.height > 0 && !el.disabled };
      });
    } catch { continue; }
    if (!info.visible || !info.own) continue;
    let kind = null;
    for (const k of ['work', 'education']) if (SECTION_ADD[k].test(info.own)) { kind = k; break; }
    if (!kind && BARE_ADD.test(info.own)) {
      for (const k of ['work', 'education']) if (SECTION_HEADING[k].test(info.heading)) { kind = k; break; }
    }
    if (kind) found.push({ kind, handle, label: info.own });
  }
  return found;
}

/** Text already typed into any box on the page, lower-cased, for "is it there already?". */
async function typedValues(scope) {
  try {
    return await scope.evaluate(() => [...document.querySelectorAll('input, textarea')]
      .map((el) => String(el.value ?? '').trim().toLowerCase()).filter(Boolean));
  } catch { return []; }
}

async function setField(scope, field, value) {
  const control = scope.locator(field.selector).first();
  if (field.kind === 'checkbox') {
    await control.setChecked(value === true);
    return (await control.isChecked()) === (value === true);
  }
  if (field.kind === 'select') {
    const options = (field.options ?? []).map((o) => (typeof o === 'string' ? o : (o.label ?? o.value ?? '')));
    const want = normalizeText(value);
    const pick = options.find((o) => normalizeText(o) === want)
      ?? options.find((o) => want && normalizeText(o).includes(want))
      ?? options.find((o) => want && normalizeText(o) && want.includes(normalizeText(o)));
    if (!pick) return null; // no matching choice: left for the person
    await control.selectOption({ label: pick });
    return normalizeText(await control.evaluate((el) => el.selectedOptions[0]?.textContent ?? '')) === normalizeText(pick);
  }
  await control.fill(String(value));
  return (await control.inputValue()) === String(value);
}

/**
 * @param {object} scope Playwright page or frame
 * @param {object} args
 * @param {object} args.candidate config.candidate (workHistory, education)
 * @param {boolean} [args.dryRun]
 * @returns {Promise<{sections: object[], filled: object[], errors: string[]}>}
 */
export async function fillRepeatedSections(scope, { candidate = {}, dryRun = false } = {}) {
  const out = { sections: [], filled: [], errors: [] };
  if (!scope || typeof scope.evaluate !== 'function' || typeof scope.locator !== 'function') return out;
  const wanted = {
    work: (Array.isArray(candidate.workHistory) ? candidate.workHistory : []).filter((r) => r?.employer || r?.title).slice(0, MAX_WORK),
    education: (Array.isArray(candidate.education) ? candidate.education : []).filter((e) => e?.institution).slice(0, MAX_EDUCATION),
  };
  if (!wanted.work.length && !wanted.education.length) return out;

  const controls = await addControls(scope);
  for (const kind of ['work', 'education']) {
    const section = { kind, wanted: wanted[kind].length, wouldAdd: 0, added: 0, skipped: 0 };
    out.sections.push(section);
    // The first matching control stands for the section; its handle is stable across entries.
    const add = controls.find((c) => c.kind === kind);
    if (!add || !wanted[kind].length) continue;

    for (const entry of wanted[kind]) {
      const anchor = normalizeText(kind === 'work' ? entry.employer : entry.institution);
      if (anchor && (await typedValues(scope)).includes(anchor)) { section.skipped += 1; continue; }
      section.wouldAdd += 1;
      if (dryRun) continue;

      const before = new Set((await scanFields(scope)).map((f) => f.selector).filter(Boolean));
      try { await add.handle.click(); } catch (err) { out.errors.push(`"${add.label}" could not be pressed: ${err.message}`); break; }
      let fresh = [];
      for (let i = 0; i < 12 && !fresh.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, i === 0 ? 50 : 100));
        fresh = applicationFields(await scanFields(scope)).filter((f) => f.selector && !before.has(f.selector));
      }
      if (!fresh.length) {
        out.errors.push(`"${add.label}" opened no fields, so ${kind === 'work' ? 'work history' : 'education'} is left for you`);
        section.wouldAdd -= 1;
        break;
      }
      const values = kind === 'work' ? workValues(entry) : educationValues(entry);
      const slotOf = kind === 'work' ? workSlot : educationSlot;
      for (const field of fresh) {
        const slot = slotOf(field);
        const value = slot ? values[slot] : null;
        if (value === null || value === undefined || value === '' || (slot === 'current' && value !== true)) continue;
        try {
          const ok = await setField(scope, field, value);
          if (ok === null) { out.errors.push(`${field.label}: no choice matches "${value}"`); continue; }
          if (!ok) { out.errors.push(`${field.label}: the form did not keep "${value}"`); continue; }
          out.filled.push({ label: field.label, selector: field.selector, value: field.kind === 'checkbox' ? 'checked' : String(value), source: 'history', kind: field.kind });
        } catch (err) {
          out.errors.push(`${field.label}: ${err.message}`);
        }
      }
      section.added += 1;
    }
  }
  return out;
}
