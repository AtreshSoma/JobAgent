/**
 * The constraints a user STATES, enforced as constraints.
 *
 * WHY THIS EXISTS. A search profile collects excluded employers, excluded
 * terms, excluded locations, employment-type preferences, a minimum contract
 * length and a minimum salary. All six were stored, shown back to the user, and
 * then governed almost nothing: `applyExclusions` (the profile one) forwarded
 * only derived seniority phrases and the `usOnly` flag, so a user could tell
 * the tool "never show me this staffing agency" and receive that agency's
 * postings at the top of the board. An excluded LOCATION merely lost geography
 * points, and any location string containing "remote" skipped the check
 * entirely.
 *
 * A stated constraint that does not filter is worse than no constraint: it
 * spends the user's attention on configuration and returns the same results.
 *
 * TWO RULES THROUGHOUT.
 *
 *  1. Only EXCLUDE on positive evidence. Every check here answers "is there
 *     proof this posting violates a stated constraint?" — never "is there proof
 *     it satisfies one?". A posting that does not state its salary, its
 *     duration or its employment type is kept and judged on fit, because most
 *     postings state none of these and filtering on silence would empty the
 *     board.
 *
 *  2. Only act on what the user actually SAID. An empty list, a zero minimum
 *     and an absent preference all mean "no constraint", not "constrain to
 *     nothing".
 */

import { normalizeText, matchedPhrases } from '../utils/textNormalize.js';

/** Months in a year, for annualizing hourly/monthly pay. */
const MONTHS = 12;

/** Full-time hours a year, for turning an hourly rate into an annual one. */
const FULL_TIME_HOURS_PER_YEAR = 2080;

/**
 * Employment-type words a user may write, mapped to the categories
 * `classifyEmployment` produces. Anything unmapped (notably "W2", which is a
 * tax classification rather than a schedule) constrains nothing here.
 */
const EMPLOYMENT_TYPE_ALIASES = {
  'full time': 'full_time',
  fulltime: 'full_time',
  'full-time': 'full_time',
  permanent: 'full_time',
  'direct hire': 'full_time',
  'part time': 'part_time',
  parttime: 'part_time',
  'part-time': 'part_time',
  contract: 'contract',
  contractor: 'contract',
  contracting: 'contract',
  '1099': 'contract',
  c2c: 'contract',
  'corp to corp': 'contract',
  freelance: 'contract',
  temporary: 'contract',
  'contract to hire': 'contract_to_hire',
  'contract-to-hire': 'contract_to_hire',
  c2h: 'contract_to_hire',
  'temp to perm': 'contract_to_hire',
};

/**
 * The employment categories this profile will accept, or null when it has
 * stated no usable preference.
 *
 * @param {string[]} types `candidate.employmentPreferences.types`
 * @returns {Set<string>|null}
 */
export function acceptedEmploymentCategories(types) {
  const out = new Set();
  for (const raw of Array.isArray(types) ? types : []) {
    const key = normalizeText(raw);
    const mapped = EMPLOYMENT_TYPE_ALIASES[key];
    if (mapped) out.add(mapped);
  }
  return out.size ? out : null;
}

/** "Remote" postings are not a presence in the excluded place. */
const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|distributed)\b/;

/**
 * Is this posting's location one the candidate ruled out?
 *
 * The old check lived in geography SCORING, where an excluded location merely
 * lost its six points and could still reach Apply on everything else — and it
 * was skipped altogether when the location string mentioned remote, so
 * "Remote" plus an excluded city passed unexamined.
 *
 * Remote still exempts a posting, because ruling out a CITY is a statement
 * about going there. The difference is that the exemption is now decided on the
 * posting reading as remote, not on the substring appearing somewhere in it.
 *
 * @param {string} location job location
 * @param {string[]} excludedLocations
 * @returns {string|null} the matched exclusion, or null
 */
export function excludedLocationMatch(location, excludedLocations) {
  const loc = normalizeText(location);
  if (!loc || REMOTE_RE.test(loc)) return null;
  const hits = matchedPhrases(loc, (excludedLocations ?? []).filter(Boolean));
  return hits[0] ?? null;
}

/**
 * An annual salary range stated by a posting, in whole currency units.
 *
 * Deliberately narrow. It reads the shapes employers actually publish — a
 * range, a single figure, hourly, monthly or annual — and returns null for
 * everything else rather than guessing. A wrong parse here DELETES a job the
 * user wanted, so silence is the only safe default.
 *
 * @param {string} text compensation text (or the JD)
 * @returns {{min: number, max: number}|null}
 */
export function parseAnnualSalary(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const lower = raw.toLowerCase();

  // Money-shaped numbers: $120,000 / $120k / 120000. A bare number without a
  // currency marker or a "k" is ignored — "2024" and "401" are not salaries.
  const amounts = [];
  const re = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*([km])?|\b(\d[\d,]{4,})\b|\b(\d{2,3})\s*k\b/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const digits = m[1] ?? m[3] ?? m[4];
    if (!digits) continue;
    let value = Number(String(digits).replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const suffix = (m[2] ?? (m[4] ? 'k' : '')).toLowerCase();
    if (suffix === 'k') value *= 1_000;
    if (suffix === 'm') value *= 1_000_000;
    amounts.push(value);
  }
  if (!amounts.length) return null;

  // Period. Unmarked figures are read as annual only when they are large
  // enough that nothing else is plausible.
  const perHour = /\b(per\s+hour|hourly|an\s+hour|\/\s*hr|\/\s*hour|p\/h)\b/.test(lower);
  const perMonth = /\b(per\s+month|monthly|a\s+month|\/\s*month|\/\s*mo)\b/.test(lower);
  const scale = perHour ? FULL_TIME_HOURS_PER_YEAR : (perMonth ? MONTHS : 1);

  const scaled = amounts.map((a) => a * scale)
    // After scaling, anything outside a plausible annual band is not pay.
    .filter((a) => a >= 10_000 && a <= 10_000_000);
  if (!scaled.length) return null;

  return { min: Math.min(...scaled), max: Math.max(...scaled) };
}

/**
 * A pay range stated IN THE DESCRIPTION, read strictly.
 *
 * `parseAnnualSalary` is for a dedicated compensation field, where every
 * number is pay. A description is not: "$5M in funding", "50,000 customers",
 * "a $2B portfolio" all look like money. Most US postings now carry a
 * pay-transparency sentence ("The pay range for this role is $120,000 -
 * $150,000 per year"), and this reads exactly that and nothing else:
 *
 *   - a currency sign on the figure ("$120,000", "$60", "$120k");
 *   - a pay word within the same stretch of text (salary, pay, compensation,
 *     wage, base, rate, hourly, per year/hour, /hr, /yr, OTE);
 *   - no "M"/"B" magnitude — nobody states a salary as "$5M";
 *   - after annualizing (hourly x 2080, monthly x 12) the figure must be a
 *     plausible salary, 15,000 – 2,000,000.
 *
 * A range is preferred over a single figure. Silence is the default: a wrong
 * parse can delete a job the user wanted under a salary floor.
 *
 * @param {string} text job description
 * @returns {{min: number, max: number, period: 'year'|'hour'|'month', text: string}|null}
 */
export function parsePayRange(text) {
  const raw = String(text ?? '');
  if (!raw.includes('$')) return null;
  const candidates = [];
  PAY_AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = PAY_AMOUNT_RE.exec(raw)) !== null) {
    const a = moneyValue(m.groups.a, m.groups.ka);
    const b = m.groups.b ? moneyValue(m.groups.b, m.groups.kb) : null;
    if (a === null || (m.groups.b && b === null)) continue;
    const start = Math.max(0, m.index - 120);
    const end = Math.min(raw.length, m.index + m[0].length + 40);
    const around = raw.slice(start, end).toLowerCase();
    const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase();
    if (!PAY_CONTEXT_RE.test(around)) continue;
    if (NOT_PAY_AFTER_RE.test(after)) continue;
    const period = PER_HOUR_RE.test(after) ? 'hour' : (PER_MONTH_RE.test(after) ? 'month' : 'year');
    const scale = period === 'hour' ? FULL_TIME_HOURS_PER_YEAR : (period === 'month' ? MONTHS : 1);
    const lo = Math.min(a, b ?? a) * scale;
    const hi = Math.max(a, b ?? a) * scale;
    if (lo < 15_000 || hi > 2_000_000) continue;
    candidates.push({ min: lo, max: hi, period, text: m[0].trim(), range: b !== null });
  }
  if (!candidates.length) return null;
  const best = candidates.find((c) => c.range) ?? candidates[0];
  const { range, ...out } = best;
  return out;
}

/**
 * The pay a posting states: its compensation field when it has one, otherwise
 * a strict read of its description (see parsePayRange). Null when neither
 * states pay, which every consumer treats as "unknown", never as "low".
 *
 * @param {object} job normalized job (or a jobs-table-shaped object)
 * @returns {{min: number, max: number, source: 'field'|'description', text?: string}|null}
 */
export function postedPay(job = {}) {
  const field = String(job.compensationText ?? job.compensation_text ?? job.rawMetadata?.compensation ?? '').trim();
  if (field) {
    const parsed = parseAnnualSalary(field);
    return parsed ? { ...parsed, source: 'field', text: field } : null;
  }
  const fromJd = parsePayRange(job.jdText ?? job.jd_text ?? '');
  return fromJd ? { min: fromJd.min, max: fromJd.max, source: 'description', text: fromJd.text } : null;
}

/** "$120,000 - $150,000", "$60–$75", "$120k to $140k", "$95,000". */
const PAY_AMOUNT_RE = /\$\s?(?<a>\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?<ka>[kKmMbB](?![a-z]))?(?:\s*(?:-|–|—|to)\s*(?:USD\s*)?\$?\s?(?<b>\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?<kb>[kKmMbB](?![a-z]))?)?/g;

/** A pay word somewhere in the stretch around a figure. */
const PAY_CONTEXT_RE = /\b(salary|salaries|pay|compensation|wage|wages|base|rate|hourly|annual|annually|per\s+(?:year|hour|annum|month)|a\s+year|an\s+hour|ote)\b|\/\s*(?:hr|hour|yr|year)\b/;

/** Words right after a figure that make it something other than pay. */
const NOT_PAY_AFTER_RE = /^\s*(?:in\s+)?(?:funding|revenue|raised|valuation|series|investment|assets|budget|customers|users|portfolio|market|(?:sign[\s-]?on|signing|referral|annual|performance|retention)?\s*bonus|sign[\s-]?on|relocation|stipend|reimbursement|allowance|401)/;

const PER_HOUR_RE = /^\s*(?:\/\s*(?:hr|hour)|per\s+hour|an\s+hour|hourly|ph\b|p\/h)/;
const PER_MONTH_RE = /^\s*(?:\/\s*(?:mo|month)|per\s+month|a\s+month|monthly)/;

/** A money figure as a number, or null for a magnitude no salary uses. */
function moneyValue(digits, suffix) {
  const s = String(suffix ?? '').toLowerCase();
  if (s === 'm' || s === 'b') return null;
  const n = Number(String(digits).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return s === 'k' ? n * 1_000 : n;
}

/**
 * Contract length in months, when the posting states one.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseContractMonths(text) {
  const raw = String(text ?? '').toLowerCase();
  if (!raw.trim()) return null;
  // Contract-to-hire has no meaningful "length": the contract phase is a
  // probation, not the engagement, so a minimum-length rule must not read it.
  if (CONTRACT_TO_HIRE_RE.test(raw)) return null;

  // DURATION NEEDS CONTRACT CONTEXT, and the LONGEST stated one wins.
  //
  // This took the FIRST "N month" anywhere in the text, so "Benefits eligible
  // after 3 months. 12 month contract." read as a 3-month contract and was
  // discarded under a 6-month minimum. A figure now counts only with a
  // contract word (contract, duration, assignment, engagement, term, project)
  // within a few words of it, on either side; among those, the maximum is
  // taken because a minimum asks how long the engagement CAN run — the same
  // reason a range ("6-12 month contract") is read by its upper bound.
  const found = [];
  const push = (n, unit) => {
    const value = unit.startsWith('y') ? n * MONTHS : n;
    if (value > 0 && value <= 120) found.push(value);
  };
  for (const re of [DURATION_THEN_CONTEXT_RE, CONTEXT_THEN_DURATION_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const a = Number(m.groups.a);
      const b = m.groups.b ? Number(m.groups.b) : null;
      push(b ? Math.max(a, b) : a, m.groups.unit);
    }
  }
  return found.length ? Math.max(...found) : null;
}

/** "contract to hire", "c2h", "temp to perm" — see parseContractMonths. */
const CONTRACT_TO_HIRE_RE = /\bcontract[\s-]*to[\s-]*(?:hire|perm(?:anent)?)\b|\bc2h\b|\btemp[\s-]*to[\s-]*perm\b/;

/** Words that make a duration a statement about the engagement. */
const CONTRACT_WORDS = '(?:contract|contractor|duration|assignment|engagement|term|project)';

/** "12 month contract", "6-12 months assignment", "1 year engagement". */
const DURATION_THEN_CONTEXT_RE = new RegExp(
  String.raw`\b(?<a>\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(?<b>\d{1,2})\s*)?[- ]?(?<unit>months?|mos?|years?|yrs?)\b(?:[\s-]+\w+){0,2}?[\s-]+${CONTRACT_WORDS}\b`,
  'g',
);

/** "Contract length: 12 months", "Duration - 6 to 9 months", "assignment of 18 months". */
const CONTEXT_THEN_DURATION_RE = new RegExp(
  String.raw`\b${CONTRACT_WORDS}\b(?:\s+\w+){0,3}?\s*[:\-–]?\s*(?:of\s+|is\s+|for\s+)?(?<a>\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(?<b>\d{1,2})\s*)?[- ]?(?<unit>months?|mos?|years?|yrs?)\b`,
  'g',
);

/**
 * Check one job against every constraint the candidate stated.
 *
 * @param {object} job normalized job
 * @param {object} candidate parsed config/candidate.json
 * @param {object} [options]
 * @param {string|(() => string)} [options.employmentCategory] the category from
 *   `classifyEmployment`, or a function returning it. Classifying costs a pass
 *   over the whole JD and runs once per posting per discovery run, while most
 *   profiles state no employment preference — so callers on the hot path pass a
 *   function and it is only called if a stated preference actually needs it.
 * @returns {{violated: boolean, category: string|null, matched: string[]}}
 */
export function checkSearchConstraints(job = {}, candidate = {}, { employmentCategory = null } = {}) {
  let resolvedCategory;
  const jobEmploymentCategory = () => {
    if (resolvedCategory === undefined) {
      resolvedCategory = typeof employmentCategory === 'function' ? employmentCategory() : employmentCategory;
    }
    return resolvedCategory;
  };
  const ok = { violated: false, category: null, matched: [] };
  if (!candidate || typeof candidate !== 'object') return ok;

  const fail = (category, matched) => ({ violated: true, category, matched });

  // 1. Employers the user never wants to see again. Matched on the COMPANY
  //    field only — a posting that merely mentions a competitor is not from it.
  const employers = candidate.prohibited?.employers ?? [];
  if (employers.length) {
    const hit = matchedPhrases(normalizeText(job.company), employers.filter(Boolean))[0];
    if (hit) return fail('excluded_employer', [hit]);
  }

  // 2. Terms the user ruled out. Title and description both, because these are
  //    subject-matter vetoes ("no on-call", "no travel") rather than identities.
  const terms = candidate.prohibited?.terms ?? [];
  if (terms.length) {
    const hit = matchedPhrases(normalizeText([job.title, job.jdText].join(' \n ')), terms.filter(Boolean))[0];
    if (hit) return fail('excluded_term', [hit]);
  }

  // 3. Locations the user ruled out (remote postings exempt).
  const excludedLocation = excludedLocationMatch(
    job.location, candidate.locationPreferences?.excludedLocations,
  );
  if (excludedLocation) return fail('excluded_location', [excludedLocation]);

  // 4. Employment type. Only when the posting's type is KNOWN — `unknown` is
  //    the common case and must not be filtered on.
  const accepted = acceptedEmploymentCategories(candidate.employmentPreferences?.types);
  if (accepted) {
    const category = jobEmploymentCategory();
    if (category && category !== 'unknown' && !accepted.has(category)) {
      return fail('employment_mismatch', [`${category.replace(/_/g, ' ')} (not among your stated types)`]);
    }
  }

  // 5. Minimum contract length, for contract work that states a duration.
  const minMonths = Number(candidate.employmentPreferences?.minContractMonths) || 0;
  if (minMonths > 0) {
    const category = jobEmploymentCategory();
    if (category === 'contract' || category === 'contract_to_hire') {
      const stated = parseContractMonths([job.title, job.jdText].join(' \n '));
      if (stated !== null && stated < minMonths) {
        return fail('contract_too_short', [`${stated}-month contract, minimum ${minMonths}`]);
      }
    }
  }

  // 6. Minimum salary. Only when the posting PUBLISHES pay and its top of range
  //    is below the floor — a range that reaches the floor is negotiable, and an
  //    unpublished one is unknown.
  const floor = Number(candidate.salaryPreference?.minAnnualUSD) || 0;
  if (floor > 0) {
    const stated = postedPay(job);
    if (stated && stated.max < floor) {
      return fail('below_salary_floor', [
        `posted up to ${Math.round(stated.max).toLocaleString('en-US')}, minimum ${floor.toLocaleString('en-US')}`,
      ]);
    }
  }

  return ok;
}
