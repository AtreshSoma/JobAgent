/**
 * Authoritative "is this location in the United States?" recognizer.
 *
 * WHY THIS EXISTS
 * The US-only discovery gate used to decide with two hand-written phrase lists:
 * a short list of US markers (five state names) and a long list of foreign
 * cities. Any US city that shares its name with a foreign one therefore lost —
 * and a great many do. Measured against real postings, the gate silently threw
 * away jobs in Dublin OH, Vienna VA, Ontario CA, Athens GA, Rome GA, Berlin CT,
 * Milan TN, Paris TX, Hamburg NY, Waterloo IA, Stockholm WI, Peru IN, Delhi CA,
 * Cairo IL and Warsaw IN: 15 of 39 sampled US locations, including two large
 * corporate hubs. Those jobs never reached scoring, so nothing in the UI could
 * show they had been dropped.
 *
 * The fix is to make the US signal COMPLETE rather than incidental: all 50
 * states, DC, and the inhabited territories, by full name and by USPS code.
 *
 * DESIGN NOTES
 *  - Abbreviations are matched against the ORIGINAL string, requiring the two
 *    letters to be upper-case and stand alone ("Dublin, OH"). Matching them
 *    case-insensitively would turn the ordinary English words "in", "or", "me",
 *    "hi", "la", "de" and "pa" into US signals.
 *  - A bare abbreviation is deliberately weaker than a state NAME, because a
 *    few codes collide with country codes ("Berlin, DE"). The caller can
 *    therefore let an explicit foreign COUNTRY name outrank an abbreviation,
 *    while a spelled-out state always wins.
 *  - "Georgia" is reported as a US state. It is also a country, but in a
 *    US-targeted job feed the state is the overwhelmingly likely reading, and
 *    the cost of being wrong is one visible row to reject rather than a
 *    silently discarded job.
 */

/** All 50 states, DC, and the inhabited territories, name -> USPS code. */
export const US_STATES = Object.freeze({
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
  'washington dc': 'DC',
  'washington d c': 'DC',
  'puerto rico': 'PR',
  guam: 'GU',
  'us virgin islands': 'VI',
  'u s virgin islands': 'VI',
  'american samoa': 'AS',
  'northern mariana islands': 'MP',
});

/** USPS code -> canonical display name, for reporting coverage by state. */
export const US_STATE_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(US_STATES).map(([name, code]) => [
    code,
    name.replace(/\b[a-z]/g, (c) => c.toUpperCase()),
  ]).reverse(), // first spelling of each code wins (e.g. "Washington Dc" -> "District Of Columbia")
));

const STATE_NAMES = Object.keys(US_STATES).sort((a, b) => b.length - a.length);
const STATE_CODES = new Set(Object.values(US_STATES));

/** Country-agnostic phrases that mean "United States" without naming a state. */
const NATIONAL_MARKERS = [
  'united states', 'united states of america', 'usa', 'u s a', 'u s',
  'us based', 'us only', 'us remote', 'remote us', 'anywhere in the us',
  'nationwide', 'continental us', 'lower 48', 'conus',
];

/** Lowercase, collapse punctuation to spaces, so "U.S.A." -> "u s a". */
function loose(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-token match inside an already-loosened string. */
function hasToken(text, term) {
  if (!term) return false;
  return new RegExp(`(^| )${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);
}

/**
 * Which US state does this location name, if any?
 *
 * @param {string} location raw location string, original casing preserved
 * @returns {{ code: string, name: string, evidence: string, strength: 'name'|'abbreviation' }|null}
 */
export function matchUsState(location) {
  const text = loose(location);
  if (!text) return null;
  for (const name of STATE_NAMES) {
    if (hasToken(text, name)) {
      const code = US_STATES[name];
      return { code, name: US_STATE_BY_CODE[code] ?? name, evidence: name, strength: 'name' };
    }
  }
  // Abbreviations are read from the ORIGINAL string so casing can be required.
  const raw = String(location ?? '');
  const match = raw.match(/(?:^|[\s,(/|-])([A-Z]{2})(?=$|[\s,).;/|-])/g);
  for (const candidate of match ?? []) {
    const code = candidate.replace(/[^A-Z]/g, '');
    if (STATE_CODES.has(code)) {
      return { code, name: US_STATE_BY_CODE[code] ?? code, evidence: code, strength: 'abbreviation' };
    }
  }
  return null;
}

/**
 * Does this location carry a national-level US marker ("United States",
 * "Remote - US", "nationwide")?
 * @param {string} location
 * @returns {string|null} the marker that matched
 */
export function matchUsNational(location) {
  const text = loose(location);
  if (!text) return null;
  return NATIONAL_MARKERS.find((marker) => hasToken(text, marker)) ?? null;
}

/**
 * Full US signal for a location.
 *
 * @param {string} location
 * @returns {{ isUs: boolean, strength: 'national'|'name'|'abbreviation'|null,
 *             state: string|null, stateName: string|null, evidence: string|null }}
 */
export function usLocationSignal(location) {
  const national = matchUsNational(location);
  const state = matchUsState(location);
  // A spelled-out state or a national marker is conclusive. An abbreviation
  // alone is reported as such so the caller can weigh it against a foreign
  // country name ("Berlin, DE").
  if (state && state.strength === 'name') {
    return { isUs: true, strength: 'name', state: state.code, stateName: state.name, evidence: state.evidence };
  }
  if (national) {
    return {
      isUs: true,
      strength: 'national',
      state: state?.code ?? null,
      stateName: state?.name ?? null,
      evidence: national,
    };
  }
  if (state) {
    return {
      isUs: true, strength: 'abbreviation', state: state.code, stateName: state.name, evidence: state.evidence,
    };
  }
  return { isUs: false, strength: null, state: null, stateName: null, evidence: null };
}

/** Total number of distinct US jurisdictions this module recognizes. */
export const US_STATE_COUNT = STATE_CODES.size;

/**
 * ISO-3166 country codes that appear as a LEADING prefix in ATS location
 * strings. Alpha-3 first (unambiguous — no US state code is three letters),
 * then alpha-2 codes that collide with a USPS state code and therefore need the
 * positional rule in `leadingForeignCountry` to be read correctly.
 *
 * Only codes actually observed in, or plausible for, employer location fields
 * are listed; this is a disambiguation aid, not a complete ISO table.
 */
const FOREIGN_ALPHA3 = Object.freeze({
  phl: 'Philippines', ind: 'India', bra: 'Brazil', mex: 'Mexico', can: 'Canada',
  gbr: 'United Kingdom', deu: 'Germany', fra: 'France', esp: 'Spain', prt: 'Portugal',
  nld: 'Netherlands', bel: 'Belgium', ita: 'Italy', che: 'Switzerland', aut: 'Austria',
  swe: 'Sweden', dnk: 'Denmark', nor: 'Norway', fin: 'Finland', pol: 'Poland',
  cze: 'Czechia', hun: 'Hungary', rou: 'Romania', ukr: 'Ukraine', grc: 'Greece',
  tur: 'Turkey', irl: 'Ireland', arg: 'Argentina', chl: 'Chile', col: 'Colombia',
  cri: 'Costa Rica', ury: 'Uruguay', aus: 'Australia', nzl: 'New Zealand',
  sgp: 'Singapore', jpn: 'Japan', chn: 'China', hkg: 'Hong Kong', twn: 'Taiwan',
  kor: 'South Korea', vnm: 'Vietnam', tha: 'Thailand', idn: 'Indonesia',
  mys: 'Malaysia', isr: 'Israel', egy: 'Egypt', ken: 'Kenya', nga: 'Nigeria',
  zaf: 'South Africa', are: 'United Arab Emirates', sau: 'Saudi Arabia', pak: 'Pakistan',
  lka: 'Sri Lanka', bgd: 'Bangladesh', npl: 'Nepal',
  bgr: 'Bulgaria', hrv: 'Croatia', svk: 'Slovakia', svn: 'Slovenia', ltu: 'Lithuania',
  lva: 'Latvia', est: 'Estonia', srb: 'Serbia', isl: 'Iceland', lux: 'Luxembourg',
  mlt: 'Malta', cyp: 'Cyprus', rus: 'Russia', ukr2: 'Ukraine', blr: 'Belarus',
  kaz: 'Kazakhstan', geo: 'Georgia (country)', arm: 'Armenia', aze: 'Azerbaijan',
  mar: 'Morocco', tun: 'Tunisia', gha: 'Ghana', per: 'Peru', ecu: 'Ecuador',
  gtm: 'Guatemala', dom: 'Dominican Republic', pan: 'Panama', slv: 'El Salvador',
  hnd: 'Honduras', bol: 'Bolivia', pry: 'Paraguay', ven: 'Venezuela',
  jor: 'Jordan', lbn: 'Lebanon', qat: 'Qatar', kwt: 'Kuwait', bhr: 'Bahrain',
  omn: 'Oman', mmr: 'Myanmar', khm: 'Cambodia', lao: 'Laos', mng: 'Mongolia',
});

const FOREIGN_ALPHA2 = Object.freeze({
  ph: 'Philippines', in: 'India', br: 'Brazil', mx: 'Mexico', ca: 'Canada',
  gb: 'United Kingdom', de: 'Germany', fr: 'France', es: 'Spain', pt: 'Portugal',
  nl: 'Netherlands', be: 'Belgium', it: 'Italy', ch: 'Switzerland', at: 'Austria',
  se: 'Sweden', dk: 'Denmark', no: 'Norway', fi: 'Finland', pl: 'Poland',
  cz: 'Czechia', hu: 'Hungary', ro: 'Romania', ua: 'Ukraine', gr: 'Greece',
  tr: 'Turkey', ie: 'Ireland', ar: 'Argentina', cl: 'Chile', co: 'Colombia',
  cr: 'Costa Rica', uy: 'Uruguay', au: 'Australia', nz: 'New Zealand',
  sg: 'Singapore', jp: 'Japan', cn: 'China', hk: 'Hong Kong', tw: 'Taiwan',
  kr: 'South Korea', vn: 'Vietnam', th: 'Thailand', id: 'Indonesia',
  my: 'Malaysia', il: 'Israel', eg: 'Egypt', ke: 'Kenya', ng: 'Nigeria',
  za: 'South Africa', ae: 'United Arab Emirates', sa: 'Saudi Arabia', pk: 'Pakistan',
  lk: 'Sri Lanka', bd: 'Bangladesh', np: 'Nepal',
  bg: 'Bulgaria', hr: 'Croatia', sk: 'Slovakia', si: 'Slovenia', lt: 'Lithuania',
  lv: 'Latvia', ee: 'Estonia', rs: 'Serbia', is: 'Iceland', lu: 'Luxembourg',
  mt: 'Malta', cy: 'Cyprus', ru: 'Russia', by: 'Belarus', kz: 'Kazakhstan',
  am: 'Armenia', az: 'Azerbaijan', ma: 'Morocco', tn: 'Tunisia', gh: 'Ghana',
  pe: 'Peru', ec: 'Ecuador', gt: 'Guatemala', do: 'Dominican Republic',
  pa: 'Panama', sv: 'El Salvador', hn: 'Honduras', bo: 'Bolivia', py: 'Paraguay',
  ve: 'Venezuela', jo: 'Jordan', lb: 'Lebanon', qa: 'Qatar', kw: 'Kuwait',
  bh: 'Bahrain', om: 'Oman', mm: 'Myanmar', kh: 'Cambodia', la: 'Laos', mn: 'Mongolia',
});

/** Leading tokens that mean the United States in the same prefix position. */
const US_PREFIX_CODES = new Set(['us', 'usa', 'ust']);

/**
 * Read a COUNTRY code used as a leading prefix in an ATS location string.
 *
 * WHY THIS EXISTS. Workday and several other systems format locations as
 * `{ISO country}-{region}-{CITY}` — "IN-KA-BANGALORE" is India/Karnataka, and
 * "PHL - TAGUIG CITY" is the Philippines. Read as a bare abbreviation, the
 * leading `IN` matches the USPS code for INDIANA, so the job registered a US
 * signal and the US-only gate then required a foreign COUNTRY name to overrule
 * it. "Bangalore" is a city, not a country, so no such name was present and
 * every one of these postings passed the filter. That is why offshore roles
 * were reaching the dashboard despite `usOnly: true`.
 *
 * The fix is positional, which is what makes it safe. A code is read as a
 * country ONLY when it leads the string and is followed by a separator:
 *   - three letters   -> unambiguous, no USPS state code is three letters
 *   - two letters     -> only when a REGION token follows ("IN-KA-..."), the
 *                        country-region-city shape. A bare "CA-San Jose" stays
 *                        Californian, because dropping a real US job is the
 *                        worse error.
 * A leading US/USA prefix returns null, so "USA-TX-Austin" is never foreign.
 *
 * @param {string} location raw location string
 * @returns {{ code: string, country: string, evidence: string }|null}
 */
export function leadingForeignCountry(location) {
  const raw = String(location ?? '').trim();
  if (!raw) return null;

  // `PHL - TAGUIG CITY`, `IN-KA-BANGALORE`, `BRA – São Paulo`.
  const m = /^([A-Za-z]{2,3})\s*[-–—]\s*(.+)$/.exec(raw);
  if (!m) return null;
  const code = m[1].toLowerCase();
  if (US_PREFIX_CODES.has(code)) return null;

  if (code.length === 3) {
    const country = FOREIGN_ALPHA3[code];
    return country ? { code: code.toUpperCase(), country, evidence: m[1] } : null;
  }

  // Two letters: require the country-region-city shape so an ambiguous
  // state-code prefix is not misread as a country. The region token may be
  // numeric — Workday emits "PH-00-Taguig" where the region is unset — so
  // letters-only here would let exactly those postings through.
  const rest = m[2];
  if (!/^([A-Za-z0-9]{1,3})\s*[-–—]\s*\S/.test(rest)) return null;
  const country = FOREIGN_ALPHA2[code];
  return country ? { code: code.toUpperCase(), country, evidence: m[1] } : null;
}
