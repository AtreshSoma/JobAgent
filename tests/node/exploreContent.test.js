/**
 * Explore JobAgent says what the code does. These tests hold it to that.
 *
 * The page (src/dashboard/public/assets/explore/) is a product overview and a
 * technical deep dive written from the source code. Prose drifts; so each part
 * of it that restates something the code defines is compared with the code:
 *
 *   - every repository path it cites exists;
 *   - its source list is the adapter registry, no more and no fewer;
 *   - its lifecycle diagram is src/lifecycle.js;
 *   - its command list is the CLI's command table;
 *   - its MCP tool list and API routes are the ones registered;
 *   - its Score Lab gives the same total and tier as the real scorer;
 *   - each of its six example fields is scored by the real scorer, has its
 *     conditions read by the real readers, and has a tailored resume the real
 *     comparison agrees adds nothing;
 *   - no one profession dominates the examples a first-time visitor sees.
 *
 * A failure here means the page is now wrong, not that the test is fussy.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ADAPTERS } from '../../src/search/index.js';
import { adapterKind } from '../../src/search/sources.js';
import { LIFECYCLE_VALUES, TRANSITIONS } from '../../src/lifecycle.js';
import { COMMAND_TABLE } from '../../src/index.js';
import { scoreJob, PREFERRED_SKILL_CREDIT, STRUCTURAL_WEIGHTS, DEFAULT_TRACK_PENALTY } from '../../src/scoring/scorer.js';
import { explainScore } from '../../src/scoring/explainScore.js';
import { DEFAULT_ELIGIBILITY_PENALTY } from '../../src/scoring/eligibility.js';
import { FIXTURE_VERIFIED_AUTO_APPLY_ATS } from '../../src/apply/autoApplyEligibility.js';
import { extractHiddenClauses } from '../../src/scoring/hiddenClauses.js';
import { extractYearsRequirement, missingCredentials } from '../../src/scoring/eligibility.js';
import { loadRoleFamilies, titleFamilies } from '../../src/profile/roleFamilies.js';
import { diffResume } from '../../src/resume/resumeDiff.js';

import {
  STATUS, JOURNEY, GATES, SOURCES, SOURCE_GROUPS, SOURCE_MODES, CAPABILITIES, CAPABILITY_AREAS,
  FIELDS, DEFAULT_FIELD, HERO, HERO_EXTRAS, SCORE_WHATIFS, SCORE_LEAD_ROWS, TIER_GLOSS, FAQ, CLOSE, BOUNDARIES,
  marks, plain, tailorLedger, tailorLines,
} from '../../src/dashboard/public/assets/explore/js/content-overview.js';
import {
  ARCH_LAYERS, ARCH_NODES, TRACES, LIFECYCLE_GROUPS, LIFECYCLE_STATES, LIFECYCLE_TRANSITIONS,
  API_GROUPS, CLI_GROUPS, MCP_TOOLS, DEEP_TOPICS,
} from '../../src/dashboard/public/assets/explore/js/content-deep.js';
import {
  SCORE_MODEL, DEFAULT_INPUTS, PRESETS, scoreInputs, freshnessFactor,
} from '../../src/dashboard/public/assets/explore/js/score-model.js';

const ROOT = process.cwd();
const EXPLORE = join(ROOT, 'src', 'dashboard', 'public', 'assets', 'explore');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const exploreSources = () => readdirSync(join(EXPLORE, 'js')).map((f) => [f, readFileSync(join(EXPLORE, 'js', f), 'utf8')]);

describe('Explore JobAgent: content matches the code', () => {
  it('cites only files that exist in the repository', () => {
    // Any quoted or backticked string that looks like a tracked path. Runtime
    // outputs (data/, logs/, reports/, resumes/output) are written by the app
    // and are not in the repository, so they are not checked.
    const PATH = /['"`]((?:src|config|scripts|tests|extension|\.github)\/[\w./-]+\.[a-z]+|[\w-]+\.(?:sh|cmd|ps1|ini)|eslint\.config\.js|vitest\.config\.js|jsconfig\.json|\.gitignore)['"`]/g;
    const cited = new Map();
    for (const [file, text] of exploreSources()) {
      for (const match of text.matchAll(PATH)) cited.set(match[1], file);
    }
    expect(cited.size).toBeGreaterThan(120);
    const missing = [...cited].filter(([path]) => !existsSync(join(ROOT, path))).map(([path, file]) => `${path} (cited in ${file})`);
    expect(missing).toEqual([]);
  });

  it('lists exactly the source adapters the search layer registers', () => {
    expect(SOURCES.map((s) => s.id).sort()).toEqual(Object.keys(ADAPTERS).sort());
    const groups = new Set(SOURCE_GROUPS.map((g) => g.id));
    for (const source of SOURCES) {
      expect(groups.has(source.group), source.id).toBe(true);
      expect(Object.keys(SOURCE_MODES), source.id).toContain(source.mode);
      // "Links you supply" is exactly the URL readers and the manual source.
      const kind = adapterKind(source.id);
      expect(source.group === 'urls', `${source.id} is a ${kind} adapter`).toBe(kind === 'url-reader' || kind === 'manual');
    }
  });

  it('marks as "on by default" only sources the shipped config enables', () => {
    const shipped = JSON.parse(read('config', 'jobboards.json')).sources;
    for (const source of SOURCES) {
      const enabled = shipped.some((s) => s.adapter === source.id && s.enabled === true);
      if (source.mode === 'on') expect(enabled, `${source.id} is described as on by default`).toBe(true);
      if (source.mode === 'key') expect(enabled, `${source.id} is described as needing a key`).toBe(false);
    }
  });

  it('draws the lifecycle exactly as src/lifecycle.js defines it', () => {
    expect(LIFECYCLE_STATES.map((s) => s.id).sort()).toEqual([...LIFECYCLE_VALUES].sort());
    expect(LIFECYCLE_TRANSITIONS).toEqual(TRANSITIONS);
    const groups = new Set(LIFECYCLE_GROUPS.map((g) => g.id));
    for (const state of LIFECYCLE_STATES) expect(groups.has(state.group), state.id).toBe(true);
  });

  it('lists every CLI command, and none that does not exist', () => {
    const real = COMMAND_TABLE.filter((c) => !c.hidden && c.kind !== 'help').map((c) => c.name).sort();
    const listed = CLI_GROUPS.flatMap((g) => g.commands.map(([name]) => name)).sort();
    expect(listed).toEqual(real);
  });

  it('lists the MCP tools the server registers', () => {
    const source = read('src', 'mcp', 'server.js');
    const block = source.match(/MCP_TOOLS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
    expect([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...MCP_TOOLS]);
  });

  it('names only API routes the server answers', () => {
    const routes = ['server.js', ...readdirSync(join(ROOT, 'src', 'dashboard', 'routes')).map((f) => join('routes', f))]
      .map((f) => read('src', 'dashboard', f)).join('\n');
    for (const route of API_GROUPS.flatMap((g) => g.routes)) {
      const [method, path] = route.split(' ');
      expect(['GET', 'POST']).toContain(method);
      if (path.includes('/:id')) {
        // Per-job routes are matched by a pattern; the action name after the id must be handled.
        const action = path.split('/:id')[1].replace(/^\//, '');
        if (action) expect(routes, route).toContain(action);
      } else {
        expect(routes, route).toContain(`'${path}'`);
      }
    }
  });

  it('describes final auto-submit as experimental, and it is unreachable from the dashboard', () => {
    const autoSubmit = CAPABILITIES.find((c) => c.name === 'Final auto-submit');
    expect(autoSubmit.status).toBe('experimental');
    const frontEnd = readdirSync(join(ROOT, 'src', 'dashboard', 'public', 'assets', 'js'))
      .map((f) => read('src', 'dashboard', 'public', 'assets', 'js', f)).join('\n');
    expect(frontEnd).not.toContain('auto-submit-batch');
    // "Refused on every ATS until one is verified live" is true while this list ships empty.
    expect(JSON.parse(read('config', 'verified_live_ats.json')).verified).toEqual([]);
    const note = TRACES.find((t) => t.id === 'autofill').notes.find((n) => n.title === 'Which ATSs are covered').items[0].toLowerCase();
    for (const ats of FIXTURE_VERIFIED_AUTO_APPLY_ATS) expect(note).toContain(ats);
  });

  it('prints only true facts under the route stops', () => {
    for (const stop of [...JOURNEY, ...GATES]) expect(stop.fact, stop.id ?? stop.after).toMatch(/\S/);
    // The one number on the route is the number of source adapters.
    const discover = JOURNEY.find((s) => s.id === 'discover').fact;
    expect(Number(discover.match(/\d+/)[0])).toBe(Object.keys(ADAPTERS).length);
  });

  it('is internally consistent: statuses, topics and relations all resolve', () => {
    const topics = new Set(DEEP_TOPICS.map((t) => t.id));
    for (const stage of JOURNEY) expect(topics.has(stage.topic), stage.id).toBe(true);
    for (const gate of GATES) expect(JOURNEY.some((s) => s.id === gate.after)).toBe(true);
    for (const cap of CAPABILITIES) {
      expect(Object.keys(STATUS), cap.name).toContain(cap.status);
      expect(CAPABILITY_AREAS, cap.name).toContain(cap.area);
      expect(topics.has(cap.topic), cap.name).toBe(true);
    }
    // All four states are in use, so the legend never describes an empty set.
    for (const status of Object.keys(STATUS)) expect(CAPABILITIES.some((c) => c.status === status), status).toBe(true);
    for (const trace of TRACES) expect(topics.has(trace.id), trace.id).toBe(true);

    const nodeIds = new Set(ARCH_NODES.map((n) => n.id));
    const layers = new Set(ARCH_LAYERS.map((l) => l.id));
    expect(nodeIds.size).toBe(ARCH_NODES.length);
    for (const node of ARCH_NODES) {
      expect(layers.has(node.layer), node.id).toBe(true);
      expect(node.files.length, node.id).toBeGreaterThan(0);
      for (const to of node.talks) expect(nodeIds.has(to), `${node.id} -> ${to}`).toBe(true);
    }
  });

  it('uses the product’s plain punctuation: no em dashes in the copy', () => {
    for (const [file, text] of exploreSources()) {
      if (!file.startsWith('content-')) continue;
      expect(text, file).not.toMatch(/—/);
    }
  });
});

/* ───────────────────────── Score Lab parity ───────────────────────── */

const NOW = new Date('2026-06-15T12:00:00Z');
const SKILLS = ['python', 'sql', 'spark', 'airflow', 'kafka', 'dbt', 'snowflake', 'databricks'];

/** A scoring config with exactly the lab's weights, categories and thresholds. */
function scoringFromModel() {
  const from = { titleFit: 'targetTitles', coreSkills: 'technicalStack', domainFit: 'industries' };
  return {
    weights: { ...SCORE_MODEL.weights, eligibility: SCORE_MODEL.penalties.eligibility, payFit: SCORE_MODEL.penalties.payFit },
    tiers: { ...SCORE_MODEL.tiers },
    categories: SCORE_MODEL.categories.map((c) => ({
      id: c.id, label: c.label, weight: c.weight, fullAt: c.fullAt, from: from[c.id], ...(c.id === 'titleFit' ? { match: 'title' } : {}),
    })),
    keywords: {},
    sponsorshipGate: { allowApplyWhen: ['Confirmed', 'Likely', 'Approved'] },
    freshness: {},
  };
}

/** Build a real posting and candidate with the properties the lab's inputs describe. */
function realCase(inputs) {
  const x = { ...DEFAULT_INPUTS, ...inputs };
  const required = SKILLS.slice(0, x.skillsFound - x.skillsPreferredOnly);
  const preferred = SKILLS.slice(x.skillsFound - x.skillsPreferredOnly, x.skillsFound);
  const level = { match: 'Senior ', up1: 'Lead ', up2: 'Principal ', up3: 'Director of ', down1: '', down2: 'Associate ', unstated: '' }[x.seniority];
  const lines = [
    'Requirements:',
    ...required.map((skill) => `- Hands-on work with ${skill}.`),
    x.domainMatch ? '- Our customers are in insurance.' : '- Our customers are in logistics.',
    x.eligibility === 'ineligible' ? '- Requires 10+ years of experience.' : '',
    x.eligibility === 'stretch1' ? '- Requires 6+ years of experience.' : '',
    x.eligibility === 'stretch2' ? '- Requires 7+ years of experience.' : '',
    preferred.length ? '\nNice to have:' : '',
    ...preferred.map((skill) => `- ${skill}`),
  ].filter(Boolean);
  const job = {
    // "II" is how a title states the mid level, one step below senior.
    title: `${level}${x.titleMatch ? 'Data Engineer' : 'Quality Inspector'}${x.seniority === 'down1' ? ' II' : ''}`,
    jdText: lines.join('\n'),
    location: { remote: 'Remote', onsite_ok: 'Austin, TX', onsite_unwanted: 'Austin, TX', unknown: '' }[x.location],
    source: x.directAts ? 'greenhouse' : 'adzuna',
    postedAt: x.ageDays === null ? null : new Date(NOW.getTime() - x.ageDays * 86_400_000).toISOString(),
  };
  const candidate = {
    targetTitles: ['data engineer'],
    technicalStack: { core: SKILLS },
    domainExperience: ['insurance'],
    seniority: 'senior',
    yearsExperience: 5,
    locationPreferences: x.location === 'onsite_ok' ? { remote: true, onsite: true } : { remote: true, onsite: false, hybrid: false },
    workAuthorization: { requiresSponsorship: x.needsSponsorship },
  };
  return { job, candidate, sponsorship: { status: x.sponsorship } };
}

function realVerdict(inputs) {
  const scoring = scoringFromModel();
  const { job, candidate, sponsorship } = realCase(inputs);
  const score = scoreJob(job, { scoring, sponsorship, candidate, now: NOW, freshnessModel: SCORE_MODEL.freshness });
  const { tier } = explainScore(score, scoring, { candidate });
  return { total: score.total, tier, breakdown: score.breakdown };
}

describe('Explore JobAgent: the Score Lab agrees with the real scorer', () => {
  it('restates the scorer’s constants', () => {
    expect(SCORE_MODEL.preferredCredit).toBe(PREFERRED_SKILL_CREDIT);
    expect(SCORE_MODEL.penalties.eligibility).toBe(DEFAULT_ELIGIBILITY_PENALTY);
    expect(SCORE_MODEL.penalties.trackFit).toBe(DEFAULT_TRACK_PENALTY);
    expect(Object.keys(SCORE_MODEL.weights).sort()).toEqual([...STRUCTURAL_WEIGHTS].sort());
    const shipped = JSON.parse(read('config', 'scoring.json'));
    expect(SCORE_MODEL.tiers).toEqual(shipped.tiers);
    for (const key of STRUCTURAL_WEIGHTS) expect(SCORE_MODEL.weights[key], key).toBe(shipped.weights[key]);
    // The lab's weights sum to 100, which is what lets points read as a score.
    const max = SCORE_MODEL.categories.reduce((s, c) => s + c.weight, 0) + Object.values(SCORE_MODEL.weights).reduce((s, w) => s + w, 0);
    expect(max).toBe(100);
    expect(freshnessFactor(0, SCORE_MODEL.freshness)).toBe(1);
    expect(freshnessFactor(7, SCORE_MODEL.freshness)).toBe(0.5);
    expect(freshnessFactor(45, SCORE_MODEL.freshness)).toBe(0);
  });

  const scenarios = [
    ['the default inputs', {}],
    ...PRESETS.map((preset) => [`preset "${preset.name}"`, preset.inputs]),
    // Every example field on the Overview, and each "what if" laid over it.
    ...FIELDS.flatMap((field) => SCORE_WHATIFS.map((w) => [`the ${field.label} example, ${w.name}`, { ...field.inputs, ...w.inputs }])),
    ['no skills found at all', { skillsFound: 0, skillsPreferredOnly: 0 }],
    ['every skill found, industry named', { skillsFound: 8, skillsPreferredOnly: 0, domainMatch: true, sponsorship: 'Confirmed' }],
    ['a title that does not match', { titleMatch: false }],
    ['no sponsorship needed, posting silent', { needsSponsorship: false, sponsorship: 'Unconfirmed', skillsFound: 7, skillsPreferredOnly: 0 }],
    ['one step up', { seniority: 'up1' }],
    ['two steps up', { seniority: 'up2' }],
    ['three steps up', { seniority: 'up3' }],
    ['one step below', { seniority: 'down1' }],
    ['two steps below', { seniority: 'down2' }],
    ['level not stated', { seniority: 'unstated' }],
    ['on site and accepted', { location: 'onsite_ok' }],
    ['on site and unwanted', { location: 'onsite_unwanted' }],
    ['location unknown', { location: 'unknown' }],
    ['an aggregator link', { directAts: false }],
    ['posted at the edge of the window', { ageDays: 7 }],
    ['posted three weeks ago', { ageDays: 21 }],
    ['no posting date', { ageDays: null }],
    ['one year short', { eligibility: 'stretch1' }],
    ['two years short', { eligibility: 'stretch2' }],
    ['far short of the stated years', { eligibility: 'ineligible', skillsFound: 8, skillsPreferredOnly: 0, domainMatch: true, sponsorship: 'Confirmed' }],
  ];

  for (const [name, inputs] of scenarios) {
    it(`gives the real total and tier for ${name}`, () => {
      const lab = scoreInputs(inputs);
      const real = realVerdict(inputs);
      expect({ total: lab.total, tier: lab.tier }, JSON.stringify(real.breakdown)).toEqual({ total: real.total, tier: real.tier });
    });
  }

  it('holds a strong score in Queue for the two reasons the scorer does', () => {
    const gated = scoreInputs(PRESETS.find((p) => p.id === 'gated').inputs);
    expect(gated.rawTier).not.toBe('Queue');
    expect([gated.tier, gated.held]).toEqual(['Queue', 'sponsorship']);
    const floor = scoreInputs(PRESETS.find((p) => p.id === 'floor').inputs);
    expect([floor.tier, floor.held]).toEqual(['Queue', 'eligibility']);
    // Pay only ever subtracts.
    expect(scoreInputs({ payShortfall: 0.25 }).raw).toBe(scoreInputs({}).raw - SCORE_MODEL.penalties.payFit);
  });
});

describe('Explore JobAgent: the tailoring claim matches the tailor (audit X1)', () => {
  const tailor = JOURNEY.find((stage) => stage.id === 'tailor');
  const said = () => [tailor.title, tailor.body, tailor.fact, ...tailor.beats.map((b) => b.text)].join(' ');

  it('does not claim nothing is removed or reworded', () => {
    // The page fit leaves out whole bullets (max_pages, default 2) and
    // accepted rewrites change wording, so neither can be denied.
    expect(said()).not.toMatch(/nothing is (?:added, )?removed/i);
    expect(said()).not.toMatch(/reworded\.|not rewritten/i);
  });

  it('says what is true: nothing invented, left-out lines listed, rewording only where you accepted it', () => {
    expect(said()).toMatch(/never invent|nothing is invented/i);
    expect(said()).toMatch(/left out/i);
    expect(said()).toMatch(/Compare with master/);
    expect(said()).toMatch(/rewording you accepted|you accepted/i);
  });
});

/* ───────────────────────── the six example fields ───────────────────────── */

describe('Explore JobAgent: the story is true for every field', () => {
  const taxonomy = loadRoleFamilies(ROOT);
  const lower = (list) => list.map((t) => t.toLowerCase());

  it('offers six fields, software first, each on a role family that exists', () => {
    expect(FIELDS.map((f) => f.id)).toEqual(['software', 'security', 'regulatory', 'nursing', 'marketing', 'finance']);
    expect(DEFAULT_FIELD).toBe('software');
    const families = JSON.parse(read('config', 'role_families.json')).families;
    for (const field of FIELDS) {
      expect(Object.keys(families), field.id).toContain(field.family);
      // The real classifier files the example's job title under that family before any other.
      const [top] = [...titleFamilies(field.job.title, taxonomy).families].sort((a, b) => b.score - a.score);
      expect(top?.id, `${field.job.title}`).toBe(field.family);
    }
    // "26 job families" is the number in the taxonomy.
    expect(Object.keys(families).length).toBe(26);
    expect(HERO.pick.note).toContain('26 ');
    expect(FAQ.find((item) => /only for tech/i.test(item.q)).a).toContain('26 ');
  });

  for (const field of FIELDS) {
    describe(field.label, () => {
      const skills = lower(field.resume.skills.master);
      const required = marks(field.posting.requires);
      const preferred = marks(field.posting.prefers);
      const postingText = `${plain(field.posting.requires)} ${plain(field.posting.prefers)}`;

      it('marks in the posting exactly the skills its score counts', () => {
        expect(skills.length).toBe(SCORE_MODEL.profileSkills);
        expect(required.length + preferred.length).toBe(field.inputs.skillsFound);
        expect(preferred.length).toBe(field.inputs.skillsPreferredOnly);
        for (const term of [...required, ...preferred]) expect(skills, term).toContain(term.toLowerCase());
        // A skill of yours the posting does not name is not marked, and what it asks for beyond your profile is not yours.
        for (const phrase of [field.gap, ...field.alsoAsked]) expect(skills, phrase).not.toContain(phrase.toLowerCase());
        // "Also asked for" and the gap are quoted from the posting, word for word.
        for (const phrase of [field.gap, ...field.alsoAsked]) expect(postingText.toLowerCase(), phrase).toContain(phrase.toLowerCase());
      });

      it('gives the model\'s score, with a verdict the page can explain', () => {
        const result = scoreInputs(field.inputs);
        expect(TIER_GLOSS[result.tier], result.tier).toMatch(/\S/);
        // The five reasons shown in full and the ones folded together add up to the score.
        const lead = SCORE_LEAD_ROWS.map((row) => result.rows.find((r) => r.id === row.id));
        expect(lead.every(Boolean)).toBe(true);
        const rest = result.rows.filter((r) => !lead.includes(r));
        const sum = [...lead, ...rest, ...result.penalties].reduce((n, r) => n + r.points, 0);
        expect(Math.round((Math.max(0, sum) / result.max) * 100)).toBe(result.total);
        // No example needs a visa: sponsorship is shown as a "what if", not in the main story.
        expect(field.inputs.needsSponsorship).toBe(false);
      });

      it('shows a hidden condition the real reader finds, under the label it gives', () => {
        const [clause] = extractHiddenClauses(field.posting.condition.sentence);
        expect(clause?.label, field.posting.condition.sentence).toBe(field.posting.condition.tag);
      });

      it('tailors by reordering and leaving out, and the real comparison agrees nothing was added', () => {
        const { master, tailored, omitted } = tailorLines(field);
        // Every tailored line is a master line; the one left out is listed.
        for (const line of tailored.slice(0, -1)) expect(master, line).toContain(line);
        expect(omitted.length).toBe(1);
        expect([...field.resume.skills.tailored].sort()).toEqual([...field.resume.skills.master].sort());
        const real = diffResume({ master, tailored, omitted }).summary;
        const page = tailorLedger(field);
        expect({ same: page.same, moved: page.moved, reordered: page.reordered, reworded: page.reworded, omitted: page.omitted, added: page.added })
          .toEqual({ same: real.same, moved: real.moved, reordered: real.reordered, reworded: real.reworded, omitted: real.omitted, added: real.added });
        expect(real.added).toBe(0);
        // Emphasis only marks terms the posting asks for, in lines that already held them.
        const asked = lower([...required, ...preferred]);
        for (const b of field.resume.bullets) for (const term of marks(b.text)) expect(asked, `${term} in "${plain(b.text)}"`).toContain(term.toLowerCase());
        for (const term of marks(field.resume.summary)) expect(asked, term).toContain(term.toLowerCase());
      });

      it('backs each matched skill with a resume line that names it', () => {
        for (const item of field.evidence) {
          const line = plain(field.resume.bullets.find((b) => b.id === item.bullet).text).toLowerCase();
          for (const skill of item.skill.split(', ')) expect(line, `${skill} in "${line}"`).toContain(skill.toLowerCase());
        }
      });

      it('keeps one posting and sets the others aside with a reason', () => {
        const kept = field.discover.filter((row) => row.outcome === 'kept');
        expect(kept.length).toBe(1);
        expect(kept[0].title).toBe(field.job.title);
        expect(field.discover.filter((row) => row.outcome === 'merged').length).toBe(1);
        // An employer's listing carries other kinds of work: at least one row is not this field's.
        expect(field.discover.some((row) => row.kind !== field.kind)).toBe(true);
        for (const row of field.discover) expect(row.label, row.title).toMatch(/\S/);
      });
    });
  }

  it('reads the stated requirements its examples show: years, a license, a clearance', () => {
    const regulatory = FIELDS.find((f) => f.id === 'regulatory');
    expect(extractYearsRequirement(`Requirements:\n${plain(regulatory.posting.requires)}`).years).toBe(6);
    expect(regulatory.inputs.eligibility).toBe('stretch1');
    const nursing = FIELDS.find((f) => f.id === 'nursing');
    const jd = `Requirements:\n${plain(nursing.posting.requires)}`;
    expect(missingCredentials(jd, { certifications: ['BLS'] })).toEqual(['an RN license']);
    expect(missingCredentials(jd, { certifications: ['RN license, Ohio'] })).toEqual([]);
    const security = FIELDS.find((f) => f.id === 'security');
    const cleared = security.discover.find((row) => row.outcome === 'excluded');
    expect(extractHiddenClauses(`${cleared.meta}.`).map((c) => c.kind)).toEqual(['clearance']);
  });

  it('never lets one profession fill the examples a first-time visitor sees', () => {
    const first = FIELDS.find((f) => f.id === DEFAULT_FIELD);
    // The morning behind the headline: the other five fields, other kinds of work, and the chosen posting.
    const hero = [first.kind, ...FIELDS.filter((f) => f !== first).map((f) => f.kind), ...HERO_EXTRAS.map((p) => p.kind)];
    expect(new Set(hero).size).toBeGreaterThanOrEqual(10);
    const shown = [...hero, ...first.discover.map((row) => row.kind)];
    const counts = shown.reduce((map, kind) => map.set(kind, (map.get(kind) ?? 0) + 1), new Map());
    for (const [kind, n] of counts) expect(n / shown.length, `${kind}: ${n} of ${shown.length}`).toBeLessThanOrEqual(1 / 3);
    // Whichever field is chosen, the same holds.
    for (const field of FIELDS) {
      const all = [field.kind, ...FIELDS.filter((f) => f !== field).map((f) => f.kind), ...HERO_EXTRAS.map((p) => p.kind), ...field.discover.map((row) => row.kind)];
      const most = Math.max(...[...new Set(all)].map((kind) => all.filter((k) => k === kind).length));
      expect(most / all.length, field.id).toBeLessThanOrEqual(1 / 3);
    }
  });
});

describe('Explore JobAgent: what is built is labelled as the code has it', () => {
  const status = (name) => CAPABILITIES.find((c) => c.name === name)?.status;

  it('marks as implemented, optional or planned what the code makes it (owner decision, 2026-11-15)', () => {
    // Built and on by default.
    for (const name of ['Work history and education', 'Skip unchanged listings', 'What gets interviews', 'Interview prep pack']) expect(status(name), name).toBe('shipped');
    // Built, and off until the person turns it on.
    for (const name of ['Drafted answers to open questions', 'Wait at a sign-in', 'Several applications at once', 'Daily scheduled search']) expect(status(name), name).toBe('optional');
    // Not built. Planned work is never described as available.
    for (const name of ['Results while a search runs', 'Packaged installer']) expect(status(name), name).toBe('planned');
    for (const cap of CAPABILITIES.filter((c) => c.status === 'planned')) expect(cap.how, cap.name).toMatch(/^Not built\./);
  });

  it('backs those labels with the code', () => {
    // Waiting at a wall and several at once are off unless a setting turns them on.
    const settings = read('src', 'utils', 'credentialManager.js');
    expect(settings).toContain('ASSIST_WAIT_FOR_WALL_SECONDS');
    expect(settings).toContain('ASSIST_CONCURRENCY');
    // Work history and education runs inside every fill.
    expect(read('src', 'automation', 'assistStages.js')).toMatch(/repeatedSections|fillRepeatedSections/);
    // The daily schedule is a command the person runs; nothing installs it.
    expect(JSON.parse(read('package.json')).scripts.schedule).toMatch(/schedule/);
    // The interview prep pack and outcome analytics exist.
    expect(existsSync(join(ROOT, 'src', 'dashboard', 'prepPack.js'))).toBe(true);
    // Drafted answers need the optional model.
    expect(existsSync(join(ROOT, 'src', 'apply', 'groundedAnswer.js'))).toBe(true);
    // No streaming of results exists.
    const server = read('src', 'dashboard', 'server.js');
    expect(server).not.toContain('text/event-stream');
  });

  it('says each thing a capability needs said: what it does, why it matters, how it works', () => {
    for (const cap of CAPABILITIES) for (const key of ['what', 'why', 'how']) expect(cap[key], `${cap.name}: ${key}`).toMatch(/\S{3,}/);
    // Short enough to read at a glance.
    for (const cap of CAPABILITIES) for (const key of ['what', 'why', 'how']) expect(cap[key].length, `${cap.name}: ${key}`).toBeLessThanOrEqual(190);
  });

  it('states the numbers the code has', () => {
    const on = SOURCES.filter((s) => s.mode === 'on');
    const nine = SOURCES.filter((s) => s.group === 'ats' && s.mode === 'on').length;
    expect(nine).toBe(9);
    expect(CAPABILITIES.find((c) => c.name === 'Employers’ application systems').what).toContain('nine ');
    expect(FAQ.find((item) => /job sites/i.test(item.q)).a).toContain('nine ');
    expect(on.length).toBe(12);
    // Eleven kinds of hidden condition.
    expect(read('src', 'scoring', 'hiddenClauses.js').match(/^ {2}\['[a-z_0-9]+',/gm).length).toBe(11);
    expect(CAPABILITIES.find((c) => c.name === 'Hidden conditions').how).toContain('Eleven ');
    // The page budget is two pages.
    expect(read('src', 'resume', 'tailor_cli.py')).toMatch(/request\.get\("max_pages"\) is not None else 2\b/);
    // No model is used unless one is switched on, and identity lines are removed first.
    expect(existsSync(join(ROOT, 'src', 'llm', 'identityUnits.js'))).toBe(true);
    expect(read('LICENSE')).toMatch(/^MIT License/);
  });

  it('closes on the real first three steps, and never says it submits', () => {
    expect(CLOSE.steps.map((step) => step.name)).toEqual(['Add your resume', 'Confirm the job titles', 'Run your first search']);
    expect(read('src', 'dashboard', 'data.js')).toContain('Run your first search');
    expect(FAQ.length).toBe(7);
    expect(FAQ[0].a).toMatch(/^No\./);
    expect(BOUNDARIES.never[0]).toMatch(/^Submits an application without you/);
  });

  it('explains the product in plain words on the Overview', () => {
    // Words a first-time visitor outside technology would not know stay under the hood.
    const overview = read('src', 'dashboard', 'public', 'assets', 'explore', 'js', 'content-overview.js');
    const copy = overview.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      // Identifiers, not copy: adapter ids, topic ids, and the `how` of a source that names its vendor.
      .replace(/\b(?:id|group|topic|family|mode|outcome|line|kind|bullet): '[^']*'/g, '')
      // The fourth argument of a register entry is the topic it links to under the hood.
      .replace(/^( {2}cap\('[^']+', '[^']+', '[a-z]+'), '[a-z]+',/gm, '$1,');
    for (const term of [/\bATS\b/, /\bpacket/i, /\bshortlist/i, /127\.0\.0\.1/, /\bSQLite\b/, /\bPlaywright\b/, /\bembeddings?\b/i, /\bJSON\b/, /\badapters?\b/i, /\bLLM\b/, /\bIMAP\b/]) {
      expect(copy, String(term)).not.toMatch(term);
    }
  });
});
