/**
 * Builds docs/explore/preview/preview.html: four static key frames of the
 * proposed Explore page, for approval before any real code changes.
 *
 *   node docs/explore/preview/build.mjs            write preview.html
 *   node docs/explore/preview/build.mjs --shoot    also photograph each frame into shots/
 *
 * The file is self-contained (the page's real tokens.css and its two fonts are
 * inlined) and is not wired into the app. There is no animation library and no
 * scroll logic: each frame is the finished state, with the motion described in
 * words under it. The only script flips the example field and the theme.
 *
 * Scores come from the page's own score model, so every number shown is what
 * the real scorer's arithmetic gives for that field's example.
 */
/* global document -- these names are used inside functions that run in the page, not in Node. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scoreInputs, SCORE_MODEL } from '../../../src/dashboard/public/assets/explore/js/score-model.js';
import { FIELDS, FIELD_OPTIONS, HERO_FIELD, REGISTER, STATUS, TIER_GLOSS } from './fields.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', '..', '..', 'src', 'dashboard', 'public', 'assets');
const b64 = (file) => readFileSync(join(ASSETS, 'fonts', file)).toString('base64');

const tokens = readFileSync(join(ASSETS, 'explore', 'tokens.css'), 'utf8')
  .replace(/url\("\/assets\/fonts\/archivo-variable\.woff2"\)/g, `url("data:font/woff2;base64,${b64('archivo-variable.woff2')}")`)
  .replace(/url\("\/assets\/fonts\/instrument-serif-400\.woff2"\)/g, `url("data:font/woff2;base64,${b64('instrument-serif-400.woff2')}")`);

/* ───────────────────────── small helpers ───────────────────────── */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, '-');
const pts = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
/** {Braces} become a marked term. */
const mark = (text, cls) => esc(text).replace(/\{([^}]+)\}/g, cls ? `<strong class="${cls}">$1</strong>` : '$1')
  .replace(/\[([^\]]+)\]/g, '<mark class="ex-floor">$1</mark>');
const ICONS = {
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  lock: 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3M6 11h12v9H6z',
  note: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5.5M12 7.6v.4',
  down: 'M6 9.5l6 6 6-6',
  plus: 'M12 5.5v13M5.5 12h13',
};
const ic = (name, size = 16) => `<svg class="ex-ic" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`;
/** One block per built field; CSS shows the chosen one. */
const perField = (render) => Object.entries(FIELDS).map(([id, f]) => `<div class="pv-field" data-for="${id}">${render(f, scoreInputs(f.inputs), id)}</div>`).join('');
const ORD = ['1st', '2nd', '3rd', '4th', '5th'];

/* ───────────────────────── frame 1: hero ───────────────────────── */

const FIELD_AT = [
  { x: 2, y: -4, z: -300, r: -8 }, { x: 36, y: -11, z: -200, r: 5 }, { x: 68, y: -3, z: -420, r: 9 },
  { x: 75, y: 27, z: -160, r: 11 }, { x: -9, y: 30, z: -380, r: -12 }, { x: 73, y: 60, z: -260, r: 8 },
  { x: 4, y: 104, z: -240, r: -6 }, { x: 36, y: 111, z: -420, r: 4 }, { x: 67, y: 99, z: -300, r: 9 },
  { x: -10, y: 73, z: -520, r: -10 },
];

const top = () => `<header class="ex-top">
    <span class="ex-brand"><span class="ex-brand-mark"></span>JobAgent</span>
    <nav class="ex-nav"><span aria-current="page">Overview</span><span>Under the hood</span></nav>
    <span class="ex-top-actions"><span class="ex-btn ex-btn-sm">Open dashboard</span></span>
  </header>`;

function hero() {
  const cloud = HERO_FIELD.map((p, i) => {
    const at = FIELD_AT[i];
    return `<div class="ex-fcard" style="--x:${at.x}%;--y:${at.y}%;--z:${at.z}px;--r:${at.r}deg;--blur:${Math.max(0, (-at.z - 300) / 200).toFixed(1)}px">
      <span class="ex-fcard-src">${esc(p.family)}</span><span class="ex-fcard-title">${esc(p.title)}</span><span class="ex-fcard-co">${esc(p.company)}</span>
      <span class="ex-fcard-bars"><i></i><i></i><i></i></span></div>`;
  }).join('');
  const ours = perField((f, s) => `<div class="ex-fcard is-ours">
      <span class="ex-fcard-src">${esc(f.family)}</span>
      <span class="ex-fcard-title">${esc(f.job.title).replace(/-/g, '\u2011')}</span>
      <span class="ex-fcard-co">${esc(f.job.company)}, ${esc(f.job.location)}</span>
      <span class="ex-fcard-score"><span class="ex-fcard-num">${s.total}</span>
        <span class="ex-fcard-verdict"><span class="ex-tier ex-tier-${slug(s.tier)}">${s.tier}</span><span class="ex-fcard-gloss">${esc(TIER_GLOSS[s.tier])}</span></span></span>
    </div>`);
  const options = FIELD_OPTIONS.map((o) => `<button type="button" role="radio" class="ex-pick" data-field="${o.id}" ${o.built ? '' : 'data-later'} aria-checked="${o.id === 'software'}">
      <span class="ex-pick-full">${esc(o.label)}</span><span class="ex-pick-short">${esc(o.short)}</span></button>`).join('');
  return `<section class="pv-screen" id="frame-hero" data-frame="hero">
  ${top()}
  <div class="ex-hero">
    <h1 class="ex-hero-title"><span class="ex-line">All the work.</span> <span class="ex-line ex-hero-call">Your call<span class="ex-lamp"></span></span></h1>
    <div class="ex-crowd" role="img" aria-label="A morning of job postings from many professions. One comes to the front with its score."><div class="ex-crowd-space">${cloud}${ours}</div></div>
    <div class="ex-hero-foot">
      <p class="ex-lede">JobAgent finds jobs in your field, shows how well each one fits, tailors your resume and fills in the application. Then it waits for you to check it and press Submit.</p>
      <div class="ex-actions"><span class="ex-btn ex-btn-solid">See how it works ${ic('arrow')}</span><span class="ex-btn">Open the dashboard</span></div>
    </div>
    <ul class="ex-trust">
      <li data-line="find"><strong>Runs on your computer</strong><span>No account to create. No cloud service.</span></li>
      <li data-line="apply"><strong>Invents nothing</strong><span>Your resume is reordered, never added to.</span></li>
      <li data-line="signal"><strong>Never submits without you</strong><span>It stops before Submit, every time.</span></li>
    </ul>
    <div class="ex-fieldpick">
      <p class="ex-fieldpick-label" id="pickLabel"><strong>See it for your field</strong><span>The same steps for any of 26 job families. Only the example changes.</span></p>
      <div class="ex-picks" role="radiogroup" aria-labelledby="pickLabel">${options}</div>
    </div>
  </div>
</section>`;
}

/* ───────────────────────── frame 2: score ───────────────────────── */

const BANDS = [['Discard', 0, 50], ['Near miss', 50, 60], ['Queue', 60, 75], ['Apply', 75, 85], ['Priority', 85, 100]];

function ruler(total, tier) {
  const bands = BANDS.map(([name, from, to]) => `<span class="ex-ruler-band ex-band-${slug(name)}" style="flex-grow:${to - from}"></span>`).join('');
  const nums = Object.values(SCORE_MODEL.tiers).sort((a, b) => a - b).map((n) => `<span style="--at:${n}">${n}</span>`).join('');
  const names = BANDS.map(([name, from, to], i) => `<span class="${i % 2 ? 'is-low' : ''}${name === tier ? ' is-current' : ''}" style="--at:${(from + to) / 2}">${name}</span>`).join('');
  return `<div class="ex-ruler"><div class="ex-ruler-track">${bands}<span class="ex-ruler-mark" style="--at:${total}"></span></div><div class="ex-ruler-nums">${nums}</div><div class="ex-ruler-names">${names}</div></div>`;
}

const LEAD_ROWS = ['titleFit', 'coreSkills', 'seniorityFit', 'geographyFit', 'freshness'];
const ROW_NAME = { titleFit: 'Job title', coreSkills: 'Skills', seniorityFit: 'Level', geographyFit: 'Location', freshness: 'How recent' };

function scorecard(f, s) {
  const lead = LEAD_ROWS.map((id) => s.rows.find((r) => r.id === id));
  const rest = s.rows.filter((r) => !LEAD_ROWS.includes(r.id));
  const restPoints = rest.reduce((n, r) => n + r.points, 0);
  const restMax = rest.reduce((n, r) => n + r.weight, 0);
  const bars = lead.map((r) => `<li class="ex-bar"><span class="ex-bar-label">${ROW_NAME[r.id]}</span><span class="ex-bar-track"><span class="ex-bar-fill" style="--v:${(r.points / r.weight).toFixed(3)}"></span></span><span class="ex-bar-num">${pts(r.points)} / ${r.weight}</span></li>`).join('');
  const penalty = s.penalties.map((p) => `<li class="ex-bar is-penalty"><span class="ex-bar-label">${esc(p.reason)}</span><span class="ex-bar-num">${pts(p.points).replace('-', '−')}</span></li>`).join('');
  const evidence = f.evidence.map((e) => `<li><span class="ex-ev-skill">${esc(e.skill)}</span><span class="ex-ev-line">${esc(e.line)}</span></li>`).join('');
  const asked = f.alsoAsked.map((p) => `<li><q>${esc(p)}</q><span class="ex-ask-add">${ic('plus', 13)}Look for this skill</span></li>`).join('');
  return `<figure class="ex-demo ex-scorecard">
  <div class="sc-top">
    <div class="sc-verdict">
      <p class="sc-figure"><span class="ex-score-num">${s.total}</span><span class="sc-side"><span class="ex-score-of">out of 100</span><span class="ex-tier ex-tier-${slug(s.tier)}">${s.tier}</span></span></p>
      <p class="sc-gloss">${esc(TIER_GLOSS[s.tier])}</p>
      ${ruler(s.total, s.tier)}
    </div>
    <div class="ex-posting">
      <p class="ex-posting-title">${esc(f.job.title)}</p>
      <p class="ex-posting-co">${esc(f.job.company)}, ${esc(f.job.location)}</p>
      <p class="ex-posting-text"><span class="ex-posting-label">Requirements</span>${mark(f.posting.requires, 'ex-hit')}</p>
      <p class="ex-posting-text"><span class="ex-posting-label">Nice to have</span>${mark(f.posting.prefers, 'ex-hit')}</p>
      <p class="ex-cond"><span class="ex-cond-tag">${ic('note', 13)}${esc(f.posting.condition.tag)}</span><span class="ex-cond-quote">“${esc(f.posting.condition.sentence)}”</span></p>
    </div>
  </div>
  <div class="sc-why">
    <section class="sc-col"><h3>Where the points come from</h3>
      <ul class="ex-bars">${bars}${penalty}</ul>
      <p class="sc-more">and ${rest.length} smaller reasons, ${pts(restPoints)} of ${restMax} points, each listed on the job</p></section>
    <section class="sc-col"><h3>Shown by your resume</h3>
      <ul class="ex-ev">${evidence}<li class="is-gap"><span class="ex-ev-skill">${esc(f.gap)}</span><span class="ex-ev-line">Asked for. Not on your resume, so it is listed as a gap and never added.</span></li></ul></section>
    <section class="sc-col"><h3>Also asked for <span>word for word from the posting, and outside what JobAgent looks for</span></h3>
      <ul class="ex-ask">${asked}</ul></section>
  </div>
  <figcaption class="ex-demo-cap">Illustrative example. The number is computed by the same arithmetic as the real scorer.</figcaption>
</figure>`;
}

const chrome = (name, n, fact) => `<div class="ex-chrome"><span class="ex-scene-name"><span class="ex-scene-dot"></span>${name}</span><span class="ex-chrome-at"><span class="ex-chrome-n">0${n}</span> of 05</span><span class="ex-chrome-fact">${fact}</span></div>`;
const beats = (list, on) => `<ol class="ex-beats">${list.map(([name, text], i) => `<li class="ex-beat${i === on ? ' is-on' : ''}"><span class="ex-beat-name"><span class="ex-beat-n">0${i + 1}</span>${name}</span>${i === on ? `<span class="ex-beat-text">${text}</span>` : ''}</li>`).join('')}</ol>`;
const rail = (name, at) => `<div class="ex-rail" data-ground="ink"><span class="ex-rail-now">${name}</span><span class="ex-rail-line">${[0, 1, 2, 's', 3, 's', 4].map((k) => (k === 's' ? '<i class="sig"></i>' : `<i class="${k < at ? 'past' : k === at ? 'here' : ''}"></i>`)).join('')}</span>
  <span class="ex-rail-field">${perField((f) => esc(f.label))}${ic('down', 14)}</span></div>`;

function score() {
  return `<section class="pv-screen" id="frame-score" data-frame="score">
  ${top()}
  <div class="ex-plate" data-ground="ivory" data-line="find">
    ${chrome('Score', 2, 'Every point explained')}
    <div class="ex-scene-inner" data-layout="split-flip">
      <div class="ex-scene-pic">${perField(scorecard)}</div>
      <div class="ex-scene-head">
        <p class="ex-scene-claim">A score you can read, point by point</p>
        <p class="ex-scene-body">Every job gets a score out of 100 that says how strong a match it is. The same job and the same profile always give the same number, and every point shows its reason.</p>
      </div>
      <div class="ex-scene-notes">
        ${beats([
    ['Match', 'Your skills are found in the posting’s own words.'],
    ['Weigh', 'Title, skills, level, location and how recent it is each earn points.'],
    ['Decide', 'The total lands on one of five verdicts, from Priority to Discard.'],
    ['Evidence', 'Each matched skill shows the line of your resume that proves it.'],
    ['Also asked for', 'What the posting wants that is outside your profile, quoted.'],
  ], 2)}
        <p class="ex-yours"><span class="ex-yours-label">Stays yours</span>What counts, and by how much, is yours to change.</p>
      </div>
    </div>
    ${rail('Score', 1)}
  </div>
</section>`;
}

/* ───────────────────────── frame 3: tailor ───────────────────────── */

function spread(f) {
  const r = f.resume;
  const kept = r.bullets.filter((b) => b.rank > 0).sort((a, b) => a.rank - b.rank);
  const left = r.bullets.filter((b) => b.rank === 0);
  const moved = kept.filter((b) => r.bullets.indexOf(b) !== kept.indexOf(b)).length;
  const master = `<div class="ex-sheet ex-sheet-master">
      <p class="ex-sheet-tab">Master resume<span class="ex-sheet-lock">${ic('lock', 13)}Read-only</span></p>
      <p class="ex-sheet-role">${esc(r.role)}</p>
      <p class="ex-sheet-sum">${mark(r.summary)}</p>
      <ul class="ex-sheet-bullets">${r.bullets.map((b) => `<li${b.rank === 0 ? ' class="will-go"' : ''}>${mark(b.text)}</li>`).join('')}</ul>
      <p class="ex-sheet-skills"><span class="ex-sheet-label">Skills</span>${r.skills.master.map(esc).join(', ')}</p>
    </div>`;
  const tailored = `<div class="ex-sheet ex-sheet-tailored">
      <p class="ex-sheet-tab">Tailored for this job<span class="ex-sheet-fit">${ic('check', 13)}2 pages, measured</span></p>
      <p class="ex-sheet-role">${esc(r.role)}</p>
      <p class="ex-sheet-sum">${mark(r.summary, 'ex-kw')}</p>
      <ul class="ex-sheet-bullets">${kept.map((b, i) => `<li>${mark(b.text, 'ex-kw')}${r.bullets.indexOf(b) !== i ? ` <span class="ex-sheet-moved">was ${ORD[r.bullets.indexOf(b)]}</span>` : ''}</li>`).join('')}</ul>
      <p class="ex-sheet-skills"><span class="ex-sheet-label">Skills</span>${r.skills.tailored.map((s, i) => (i < r.wanted.length ? `<strong class="ex-kw">${esc(s)}</strong>` : esc(s))).join(', ')}</p>
    </div>`;
  // The statuses of src/resume/resumeDiff.js: the role line and summary are unchanged, each kept
  // bullet sits in a new place, and the skills line holds the same skills in a new order.
  const cells = [['Unchanged', 2 + kept.length - moved], ['Moved up', moved], ['Reordered', 1], ['Reworded', 0], ['Left out', left.length], ['Added', 0]];
  return `<figure class="ex-demo ex-spread">
  <p class="ex-wanted"><span class="ex-wanted-label">The posting asks for</span>${r.wanted.map((w) => `<span class="ex-want">${esc(w)}</span>`).join('')}<span class="ex-want is-gap">${esc(f.gap)}</span></p>
  <div class="ex-sheets">${master}${tailored}</div>
  <div class="ex-compare">
    <p class="ex-compare-title">Compare with master</p>
    <dl class="ex-compare-cells">${cells.map(([k, v]) => `<div class="${k === 'Added' ? 'is-proof' : ''}"><dd>${v}</dd><dt>${k}</dt></div>`).join('')}</dl>
    <ul class="ex-compare-notes">
      <li><strong>Left out to fit 2 pages:</strong> “${esc(left[0].text)}”</li>
      <li><strong>${esc(f.gap)}</strong> is in the posting and not in your resume. It is reported as a gap and never added.</li>
    </ul>
  </div>
  <figcaption class="ex-demo-cap">Illustrative example. Every line on the right is a line from the left.</figcaption>
</figure>`;
}

function tailor() {
  return `<section class="pv-screen" id="frame-tailor" data-frame="tailor">
  ${top()}
  <div class="ex-plate" data-ground="forest" data-line="apply">
    ${chrome('Tailor', 3, 'Your words, reordered')}
    <div class="ex-scene-inner" data-layout="split">
      <div class="ex-scene-head">
        <p class="ex-scene-claim">Your resume, reordered for this job. Never invented.</p>
        <p class="ex-scene-body">Each job gets its own copy of your resume, with the lines that matter most to it moved to the top. Your master resume is never changed.</p>
      </div>
      <div class="ex-scene-notes">
        ${beats([
    ['Read', 'The posting’s terms are sorted by how much it wants them.'],
    ['Reorder', 'Your strongest lines for this job move to the top.'],
    ['Emphasize', 'Terms the posting asks for are set in bold, only where you already wrote them.'],
    ['Fit', 'The page count is measured. A line left out to fit is listed, never hidden.'],
    ['Account', 'Compare with master shows every move. Added is always zero.'],
  ], 4)}
        <p class="ex-yours"><span class="ex-yours-label">Stays yours</span>Wording changes only where you accept a rewrite that was checked against your own lines.</p>
      </div>
      <div class="ex-scene-pic">${perField(spread)}</div>
    </div>
    ${rail('Tailor', 2)}
  </div>
</section>`;
}

/* ───────────────────────── frame 4: the register ───────────────────────── */

function register() {
  const all = Object.values(REGISTER).flat();
  const count = (status) => all.filter((row) => row[2] === status).length;
  const shown = 'Apply';
  const tally = Object.entries(STATUS).map(([id, meta]) => `<button type="button" class="lg-stat" data-status="${id}">
      <span class="lg-stat-n">${count(id)}</span><span class="lg-stat-name">${meta.label}</span><span class="lg-stat-note">${meta.note}</span></button>`).join('');
  const bar = Object.keys(STATUS).map((id) => `<i data-status="${id}" style="flex-grow:${count(id)}"></i>`).join('');
  const tabs = Object.entries(REGISTER).map(([area, rows]) => `<button type="button" class="lg-tab" aria-selected="${area === shown}">${area}<span class="ex-count">${rows.length}</span></button>`).join('');
  const next = 'Track';
  const row = ([name, what, status, fresh]) => `<li class="lg-row">
      <span class="lg-name">${esc(name)}${fresh ? '<span class="lg-new">New</span>' : ''}</span>
      <span class="lg-what">${esc(what)}</span>
      <span class="ex-status ex-status-${status}">${STATUS[status].label}</span></li>`;
  const group = (area, cls = '') => `<div class="lg-group ${cls}"><h3 class="lg-group-name">${area}</h3><span class="ex-count">${REGISTER[area].length} capabilities</span></div>
  <ul class="lg-rows ${cls}">${REGISTER[area].map(row).join('')}</ul>`;
  return `<section class="pv-screen ex-ledger" id="frame-register" data-frame="register">
  ${top()}
  <div class="lg-head">
    <div class="lg-title"><h2 class="ex-big">What is built, and what is not yet</h2>
      <p class="ex-section-lede">${all.length} capabilities, each marked with how finished it is. Optional ones are complete and switched off. Planned ones do not exist yet.</p></div>
    <div class="lg-tally"><div class="lg-bar" aria-hidden="true">${bar}</div><div class="lg-stats" role="group" aria-label="Filter by status">${tally}</div></div>
  </div>
  <nav class="lg-tabs" aria-label="Jump to an area">${tabs}</nav>
  ${group(shown)}
  <p class="lg-foot"><span class="lg-new">New</span> arrived in version 0.2.3 or later.</p>
  ${group(next, 'lg-peek')}
</section>`;
}

/* ───────────────────────── the notes under each frame ───────────────────────── */

const notes = (title, moments) => `<aside class="pv-notes"><h2>${title}</h2><dl>${moments.map(([name, start, end, proves]) => `<div><dt>${name}</dt><dd><strong>Starts:</strong> ${start}</dd><dd><strong>Ends:</strong> ${end}</dd><dd><strong>Proves:</strong> ${proves}</dd></div>`).join('')}</dl></aside>`;

const NOTES = {
  hero: notes('Frame 1. Hero, with “See it for your field”', [
    ['The morning arrives', 'Cards from ten professions drift in from depth, out of focus, none of them yours.', 'One card comes forward and sharpens: the chosen field’s posting, with its score and what the score means.', 'This is for many kinds of work, and it sorts a noisy morning down to the one job worth reading.'],
    ['Changing field', 'The front card turns away into the crowd (160 ms).', 'The new field’s posting comes forward with its own score. Nothing else in the hero moves. A screen reader hears “Showing the example for Regulatory Affairs.”', 'Same tool, same steps, your kind of job. The choice then follows the reader through every chapter and is kept in the link.'],
  ]),
  score: notes('Frame 2. Score', [
    ['The score assembles', 'The number reads 0. Skills light up in the posting one at a time.', 'Each bar that fills adds its points to the number, so the total on screen is always the sum of what has been shown. It lands on its verdict.', 'The score is arithmetic, not a judgement. (Today the number counts up on its own and shows 45 beside full bars if you pause.)'],
    ['Evidence, then gaps', 'The three columns under the score are quiet.', 'Each matched skill draws a line to the resume sentence that proves it, then the unmet items appear: one gap, and what the posting asked for outside your profile.', 'It never claims a skill for you, and it tells you what it does not know to look for.'],
  ]),
  tailor: notes('Frame 3. Tailor', [
    ['The resume reorders itself', 'The tailored sheet is a copy of the master, in the master’s order.', 'Line by line, each bullet lifts and travels to its new place; the one that will not fit slides out to the ledger. Then the posting’s terms turn bold where they already were.', 'Tailoring is reordering and emphasis. Every sentence on the right exists on the left.'],
    ['The ledger settles', 'Five counters at zero.', 'They count to the moves just watched. “Added” stays at 0 and is ringed.', 'The claim “nothing invented” is a number you can check, on every resume.'],
  ]),
  register: notes('Frame 4. Capability register', [
    ['Counts first', 'The bar is empty.', 'The bar fills in four segments and the counts settle, once, when the section is reached.', 'How much is finished, at a glance, before a single row is read.'],
    ['Filter and area', 'One area’s rows are shown.', 'Choosing a status or an area swaps the rows in place with a short fade (no layout jump). Rows marked New arrived in 0.2.3 or later.', 'Nothing is hidden in collapsed groups, and planned work is plainly marked as not built.'],
  ]),
};

/* ───────────────────────── page ───────────────────────── */

const css = readFileSync(join(HERE, 'preview.css'), 'utf8');
const html = `<!doctype html>
<html lang="en" data-field="software">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Explore JobAgent: design preview</title>
<meta name="color-scheme" content="light dark">
<style>
${tokens}
${css}
</style>
</head>
<body class="ex">
<div class="pv-bar">
  <strong>Explore JobAgent: design preview</strong><span class="pv-bar-note">Static. Four key frames. Not wired into the app.</span>
  <span class="pv-bar-ctl">Field <button type="button" data-set-field="software">Software Engineer</button><button type="button" data-set-field="regulatory">Regulatory Affairs</button></span>
  <span class="pv-bar-ctl">Theme <button type="button" data-set-theme="light">Light</button><button type="button" data-set-theme="dark">Dark</button></span>
</div>
<p class="sr-only" role="status" id="pvLive"></p>
${hero()}${NOTES.hero}
${score()}${NOTES.score}
${tailor()}${NOTES.tailor}
${register()}${NOTES.register}
<script>
(() => {
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  const names = ${JSON.stringify(Object.fromEntries(Object.entries(FIELDS).map(([id, f]) => [id, f.label])))};
  function setField(id) {
    if (!names[id]) return;
    root.dataset.field = id;
    for (const b of document.querySelectorAll('[data-field]')) if (b.matches('button')) b.setAttribute('aria-checked', String(b.dataset.field === id));
    document.getElementById('pvLive').textContent = 'Showing the example for ' + names[id] + '.';
  }
  if (q.get('field')) setField(q.get('field'));
  if (q.get('theme')) root.dataset.theme = q.get('theme');
  if (q.has('shot')) root.dataset.shot = '';
  document.addEventListener('click', (event) => {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.dataset.setField) setField(b.dataset.setField);
    if (b.dataset.field && !b.hasAttribute('data-later')) setField(b.dataset.field);
    if (b.dataset.setTheme) root.dataset.theme = b.dataset.setTheme;
  });
})();
</script>
</body>
</html>
`;
writeFileSync(join(HERE, 'preview.html'), html);
console.log(`preview.html written (${(html.length / 1024).toFixed(0)} KB)`);

/* ───────────────────────── screenshots ───────────────────────── */

if (process.argv.includes('--shoot')) {
  const { chromium } = await import('playwright');
  const out = join(HERE, 'shots');
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const url = pathToFileURL(join(HERE, 'preview.html')).href;
  const plan = [['hero', ['software', 'regulatory']], ['score', ['software', 'regulatory']], ['tailor', ['software', 'regulatory']], ['register', ['software']]];
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: theme, deviceScaleFactor: tag === 'phone' ? 1.5 : 1 });
      for (const [frame, fields] of plan) {
        for (const field of fields) {
          await page.goto(`${url}?shot&field=${field}&theme=${theme}`);
          await page.evaluate(() => document.fonts.ready);
          const el = page.locator(`#frame-${frame}`);
          const name = `${frame}${frame === 'register' ? '' : `-${field}`}-${tag}-${theme}.jpg`;
          await el.screenshot({ path: join(out, name), type: 'jpeg', quality: 84 });
          const box = await el.boundingBox();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          console.log(`${name}  ${Math.round(box.width)}x${Math.round(box.height)}${overflow > 0 ? `  OVERFLOW ${overflow}px` : ''}`);
        }
      }
      await page.close();
    }
  }
  await browser.close();
}
