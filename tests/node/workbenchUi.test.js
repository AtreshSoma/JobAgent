import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { POSTED_WINDOWS } from '../../src/dashboard/data.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css');
const app = read('../../src/dashboard/public/assets/js/app.js');

describe('dashboard shell structure', () => {
  it('exposes every element id the application script binds to', () => {
    // If markup and script drift apart the UI silently half-renders, so the
    // contract between them is asserted directly.
    for (const id of [
      'health', 'tabs', 'rows', 'pager', 'detail', 'nextActions', 'activeFilters',
      'srcRows', 'sponRows', 'stateRows', 'blockRows', 'dailyRows',
      'selbar', 'selCount', 'selAll', 'toasts', 'conn', 'runStatus', 'offline',
      'btnDiscover', 'btnPrepare', 'btnCancel', 'autoApplyBtn', 'cmpBtn',
    ]) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it('declares every filter control the script reads', () => {
    for (const id of [
      'q', 'fit', 'appStatus', 'postedWithinHours', 'sponsorship', 'employmentType', 'source', 'ats',
      'resumeStatus', 'remoteOnly', 'sponsorshipGated', 'undated',
      'includeClosed', 'pageSize',
    ]) {
      expect(html, `missing filter #${id}`).toContain(`id="${id}"`);
    }
  });

  it('asks about closed jobs positively, with every checkbox filter off by default', () => {
    // "Hide closed ✓" was a checked-by-default double negative: it read as an
    // active filter you had to UNcheck, and its own chip said the opposite.
    expect(html).toContain('id="includeClosed"');
    expect(html).toContain('Closed jobs<');
    expect(html).not.toContain('id="hideClosed"');
    expect(html).not.toMatch(/<input type="checkbox" id="\w+" checked>/);
    // The API still speaks hideClosed; the UI just inverts it at the boundary.
    expect(app).toContain("p.set('hideClosed', String(!$('includeClosed').checked))");
  });

  it('moves rows-per-page out of the filters and into the pager', () => {
    // Page size changes how MUCH of a result set you see, never which jobs
    // match, so it does not belong among the filters.
    const pagerBar = html.slice(html.indexOf('class="pagerbar"'), html.indexOf('class="analytics"'));
    expect(pagerBar).toContain('id="pageSize"');
    const filterBar = html.slice(html.indexOf('class="filterbar"'), html.indexOf('id="activeFilters"'));
    expect(filterBar).not.toContain('id="pageSize"');
  });

  it('offers posting age as a segmented switch, not a dropdown', () => {
    // Mutually exclusive choices belong on one row where each is visible and
    // one click away, and where clicking the active one clears it — a <select>
    // hid them behind a click and needed an extra "any date" option.
    expect(html).toContain('id="postedWithinHours"');
    expect(html).toContain('class="seg"');
    expect(html).not.toContain('id="last24h"');
    expect(app).toContain("'set-posted'");
    expect(app).toContain('function syncSegments');
    // Clicking the active segment clears it.
    expect(app).toContain("filterValue('postedWithinHours') === target.dataset.value ? '' : target.dataset.value");
  });

  it('offers the windows the filter actually honors — including a week', () => {
    // The button values and POSTED_WINDOWS must not drift: a chip offering a
    // window the filter ignores would look active over an unfiltered board.
    // A week matters because that is where the jobs are — one measured run had
    // 5 postings under 24h old and 4,439 under a week.
    const offered = [...html.matchAll(/data-action="set-posted"\s+data-value="(\d+)"/g)]
      .map((m) => Number(m[1]));
    expect(offered).toEqual(expect.arrayContaining([3, 6, 24, 72, 168]));
    for (const v of offered) expect(POSTED_WINDOWS).toContain(v);
  });

  it('labels a week as a week, not as 168h', () => {
    expect(app).toContain('function humanizeHours');
    expect(app).toContain('humanizeHours(value)');
  });

  it('reads, writes, and clears every filter through one set of accessors', () => {
    // Five behaviours (query string, chip, reset, tile-applied filters, active
    // highlighting) used to each poke at the DOM their own way, so a control
    // that was not a <select> or checkbox could be set but never chipped.
    for (const fn of ['function filterValue', 'function setFilterValue', 'function clearFilter']) {
      expect(app).toContain(fn);
    }
    expect(app).toContain('for (const id of [...FILTER_IDS, ...TOGGLE_IDS]) clearFilter(id);');
    expect(app).not.toMatch(/\$\((?:id|key)\)\.value = /);
  });

  it('keeps every filter inline in two lanes, with no popover at all', () => {
    // A dropdown pane covered the very rows it had just filtered, hid its own
    // active state behind a count badge, and needed open/close/outside-click/
    // Escape/clear/done plumbing to be usable. Two visible lanes need none of it.
    expect(html).toContain('class="filters filters-more"');
    expect(css).toContain('.filters-more');
    for (const gone of ['id="moreFilters"', 'id="moreFiltersPanel"', 'id="moreFiltersCount"',
      'toggle-more-filters', 'close-more-filters', 'clear-advanced-filters']) {
      expect(html, `"${gone}" should be gone`).not.toContain(gone);
    }
    for (const gone of ['setMoreFilters', 'closeMoreFilters', 'syncAdvancedBadge',
      'advancedFilterCount', 'ADVANCED_IDS']) {
      expect(app, `${gone}() should be gone`).not.toContain(gone);
    }
    expect(css).not.toContain('.secondary-filters');
    // Each second-lane select names its own field, so no labels are needed and
    // nothing has to be opened to see what is on.
    for (const placeholder of ['Any sponsorship', 'Any job type', 'Any source',
      'Any ATS', 'Any resume']) {
      expect(html, `missing self-describing option "${placeholder}"`).toContain(`>${placeholder}<`);
    }
  });

  it('keeps the second lane visually secondary rather than bulky', () => {
    const lane = css.slice(css.indexOf('.filters-more {'), css.indexOf('.filters-sep {'));
    // Smaller controls and a hairline rule, not a second full-height toolbar.
    expect(lane).toMatch(/border-top:/);
    expect(lane).toMatch(/height: 30px/);
    expect(lane).toMatch(/font-size: 12\.5px/);
  });

  it('declares the base control styles BEFORE the lane-2 overrides', () => {
    // `.filters select` and `.filters-more select` have identical specificity,
    // so source order decides. With the base rule last, lane 2's 30px controls
    // were silently reset to 34px and the lane was never actually secondary.
    const base = css.indexOf('.filters input[type=text], .filters input[type=search], .filters select');
    const lane = css.indexOf('.filters-more select {');
    expect(base).toBeGreaterThan(0);
    expect(lane).toBeGreaterThan(base);
  });

  it('lets the second lane shrink so it can never spill onto a third row', () => {
    // A <select> sizes to its WIDEST option ("Contract-to-hire"), ~40px more
    // than the label it displays — enough to push the last toggle down a row.
    const lane = css.slice(css.indexOf('.filters-more select {'), css.indexOf('.filters-more .toggle'));
    expect(lane).toMatch(/flex: 1 1 \d+px/);
    expect(lane).toMatch(/min-width: 0/);
    expect(lane).toMatch(/max-width: \d+px/);
  });

  it('runs one left alignment axis down the page', () => {
    // The tabs, the health facts, the filter card, the chips and the table all
    // start at the same x. Right-aligning the health facts floated them away
    // from everything else and put the numbers furthest from their tabs.
    const band = css.slice(css.indexOf('.pipeline {'), css.indexOf('.health {'));
    expect(band).toMatch(/align-items: flex-start/);
    expect(band).toMatch(/flex-direction: column/);
    expect(css.slice(css.indexOf('.health {'), css.indexOf('.stat {'))).not.toMatch(/margin-left: auto/);
    expect(css).toContain('justify-content: flex-start');
    // The run pill and its panel are anchored left too, next to the connection
    // state, so the header reads identity -> status -> progress -> actions.
    expect(html.indexOf('id="runbox"')).toBeLessThan(html.indexOf('class="spacer"'));
    expect(css.slice(css.indexOf('.run-details {'))).toMatch(/^\s*position: absolute; top: calc\(100% \+ 8px\); left: 0;/m);
  });

  it('offers a status filter option for every status the app can surface', () => {
    // A next-action linking to a status with no matching <option> silently
    // cleared the filter and showed the whole board instead.
    for (const status of [
      'discovered', 'scored', 'shortlisted', 'needs_review', 'approved',
      'ready_for_submit', 'submit_unverified', 'blocked', 'failed', 'cancelled',
      'skipped', 'submitted', 'rejected', 'archived', 'discarded', 'date_unconfirmed',
    ]) {
      expect(html, `no status option for "${status}"`).toContain(`<option value="${status}">`);
    }
  });

  it('keeps the primary workflow reachable from the shell', () => {
    for (const label of ['Find new jobs', 'Find &amp; prepare', 'Add by URL', 'Interview Prep']) {
      expect(html).toContain(label);
    }
    for (const action of [
      'batch-autofill', 'batch-prepare', 'batch-approve', 'batch-decide', 'compare',
    ]) {
      expect(html).toContain(`data-action="${action}"`);
    }
    expect(html).toContain('/learn/');
  });

  it('links its stylesheet and module script rather than inlining them', () => {
    expect(html).toContain('<link rel="stylesheet" href="/assets/css/app.css">');
    expect(html).toContain('<script type="module" src="/assets/js/app.js"></script>');
  });
});

describe('no inline event handlers or inline styles', () => {
  it('uses delegated data-action wiring, never on* attributes', () => {
    // Inline handlers were how a job id containing an apostrophe could break a
    // row or execute as script; they also force script-src 'unsafe-inline'.
    const inlineHandlers = html.match(/\son[a-z]+\s*=/gi) ?? [];
    expect(inlineHandlers).toEqual([]);
    expect(html).toContain('data-action=');
  });

  it('keeps markup free of style attributes', () => {
    expect(html.match(/\sstyle="/g) ?? []).toEqual([]);
  });

  it('never interpolates a job id into executable text', () => {
    // Ids travel as data-id attributes and are read back via dataset. Comments
    // are stripped first so prose ABOUT the old pattern does not trip this.
    const code = app
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\bon(?:click|change|input|submit)\s*=/);
    expect(code).not.toMatch(/setAttribute\(\s*['"]on/);
    expect(app).toContain("'data-id': job.id");
    expect(app).toContain('target.dataset.id');
  });
});

describe('safety guarantees are preserved in the UI', () => {
  it('ordinary Auto-fill never requests a final submit', () => {
    expect(app).toContain('/api/assist-batch');
    // The advanced auto-submit endpoint must not be reachable from this UI.
    expect(app).not.toContain('/api/auto-submit-batch');
    expect(app).not.toContain('autoSubmit: true');
    expect(app).toMatch(/stops before Submit/i);
  });

  it('manual submission stays explicit and honest about verification', () => {
    expect(app).toContain('verified: Boolean(confirmation)');
    expect(app).toMatch(/pending your verification/i);
    expect(app).toMatch(/Not counted as applied/i);
  });

  it('surfaces the packet stop-before-submit guarantee for review', () => {
    expect(app).toContain('Stops before submit');
    expect(app).toContain('submit-ready flag');
  });

  it('escapes untrusted values used in class names', () => {
    expect(app).toContain('function esc(value)');
  });
});

describe('board pagination and reconciliation', () => {
  it('renders the real match total, not just the returned page', () => {
    // The board previously showed the API's default 200-row cap while the tab
    // badges counted every match, hiding ~1,400 jobs with no indication.
    expect(app).toContain('function renderPager');
    expect(app).toContain('Showing ');
    expect(app).toContain("p.set('page'");
    expect(app).toContain("p.set('limit'");
  });

  it('offers page navigation controls', () => {
    for (const label of ['« First', '‹ Prev', 'Next ›', 'Last »']) {
      expect(app).toContain(label);
    }
  });

  it('clears manual filters when a tab scope is chosen so counts agree', () => {
    expect(app).toContain("'set-tab'");
    expect(app).toContain('renderTabs();');
  });
});

describe('master resume management', () => {
  it('gives the master resume its own screen, reachable from the places it matters', () => {
    expect(html).toContain('id="dlgMaster"');
    expect(html).toContain('id="masterBody"');
    // From the menu, from the Resume library, and from a job with no resume yet.
    expect(html).toContain('data-action="open-master"');
    expect(app).toContain("'open-master'");
    expect(app.match(/'data-action': 'open-master'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('supports viewing the real contents, downloading to edit, and uploading back', () => {
    expect(app).toContain("api('/api/master-resume')");
    expect(app).toContain("href: '/api/master-resume/file'");
    expect(app).toContain("postJson('/api/master-resume'");
    expect(app).toContain('Download to edit');
    // A .docx-only picker, opened by a real button rather than a bare input.
    expect(html).toContain('id="masterFile"');
    expect(html).toContain('accept=".docx');
    expect(app).toContain("'pick-master-file'");
  });

  it('keeps replacement reversible and says so', () => {
    expect(app).toContain("postJson('/api/master-resume/restore'");
    expect(app).toContain("'restore-master'");
    expect(app).toMatch(/previous version kept/i);
    // The read-only guarantee is stated where the file is managed.
    expect(html).toContain('Opened read-only');
  });

  it('warns when the master is missing or unreadable instead of failing silently', () => {
    expect(app).toContain('No master resume yet.');
    expect(app).toContain('master.textError');
    expect(app).toContain('stalePackets');
  });
});

describe('accessibility', () => {
  it('makes board rows keyboard operable', () => {
    expect(app).toContain("tabindex: '0'");
    expect(app).toContain("event.key === 'Enter'");
    expect(app).toContain("event.key === 'ArrowDown'");
  });

  it('uses native dialogs so Escape, focus trapping, and backdrop work', () => {
    expect(html).toMatch(/<dialog id="dlgResume"/);
    expect(html).toMatch(/<dialog id="dlgSubmit"/);
    expect(html).toMatch(/<dialog id="dlgAddUrl"/);
    expect(app).toContain('showModal()');
    expect(app).toContain('lastFocused');
  });

  it('lets the native resume dialog become hidden again after close', () => {
    expect(css).not.toMatch(/#dlgResume\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/#dlgResume\[open\]\s*\{[^}]*display:\s*flex/);
  });

  it('reloads the selected job after a re-tailor refresh', () => {
    expect(app).toMatch(/async function refreshAll\(\)[\s\S]*if \(state\.selectedId\) await selectJob\(state\.selectedId\)/);
  });

  it('marks up tabs and live regions for assistive tech', () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-live="polite"');
    expect(app).toContain("role: 'tab'");
    expect(app).toContain("'aria-selected'");
  });

  it('honors reduced-motion and provides visible focus', () => {
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain(':focus-visible');
  });
});

describe('theme and responsive design', () => {
  it('supports an explicit light theme alongside the default dark one', () => {
    expect(css).toContain(':root[data-theme="light"]');
    expect(app).toContain("savePreference('theme', next)");
    expect(app).toContain("localStorage.setItem(`jobagent-${key}`");
  });

  it('remembers view preferences but never restores hidden filters', () => {
    // Reopening a board that is silently narrowed reads as lost data; the
    // ordering and row count you chose are just the tool remembering you.
    expect(app).toContain("savePreference('sort'");
    expect(app).toContain("savePreference('pageSize'");
    for (const id of ['fit', 'appStatus', 'sponsorship', 'includeClosed']) {
      expect(app, `filter #${id} must not be persisted`).not.toContain(`savePreference('${id}'`);
    }
    // A stale or hand-edited value must not strand the board in a state the
    // controls cannot reach.
    expect(app).toContain('Object.hasOwn(SORT_DIRECTION, savedSort)');
    expect(app).toContain(".options].some((o) => o.value === savedPageSize)");
  });

  it('collapses to a single column on narrow viewports', () => {
    expect(css).toContain('@media (max-width: 1240px)');
    expect(css).toContain('@media (max-width: 860px)');
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
  });
});

describe('the top pane states things once', () => {
  it('puts the work queues and the health facts in one band', () => {
    // Three stacked bands (topbar, nine metric tiles, tabs) spent ~90px before
    // the first job row and restated several counts in two visual languages.
    expect(html).toContain('class="pipeline"');
    const band = html.slice(html.indexOf('class="pipeline"'), html.indexOf('<main'));
    expect(band).toContain('id="tabs"');
    expect(band).toContain('id="health"');
    expect(html).not.toContain('class="metrics"');
    expect(css).toContain('.pipeline {');
  });

  it('never shows a number the tabs already carry', () => {
    // "awaiting approval" == Needs review, "ready to submit" == Ready to apply,
    // "submitted" == Submitted. Duplicating them is what made the top busy.
    const facts = app.slice(app.indexOf('const HEALTH_FACTS'), app.indexOf('function statNode'));
    for (const duplicated of ['pendingReview', 'readyForSubmit', 'submittedTotal']) {
      expect(facts, `${duplicated} duplicates a tab`).not.toContain(duplicated);
    }
    // What remains is corpus size, freshness, fit, and coverage.
    for (const kept of ['jobsTracked', 'discoveredLast24h', 'postedLast24h', 'strongFit']) {
      expect(facts).toContain(kept);
    }
  });

  it('shows attention flags only when they are non-zero and have no tab', () => {
    const flags = app.slice(app.indexOf('const HEALTH_FLAGS'), app.indexOf('function statNode'));
    for (const key of ['submitUnverified', 'needsSponsorshipCheck', 'undatedDropped']) {
      expect(flags).toContain(key);
    }
    expect(app).toContain("if ((stats.totals[flag.key] ?? 0) === 0) continue;");
  });

  it('states nationwide coverage as data, and lets it be inspected', () => {
    // "Are we really searching every state?" has to be answerable from the UI.
    expect(app).toContain('coverage.statesCovered');
    expect(app).toContain('US states');
    expect(html).toContain('Where the jobs are');
    expect(html).toContain('id="stateRows"');
  });
});

describe('board sorting', () => {
  it('marks the column the board is actually sorted by, from state', () => {
    // Setting aria-sort on click left a stale indicator after Reset, and never
    // marked the default sort at all.
    expect(app).toContain('function syncSortIndicator');
    expect(app).toContain('SORT_DIRECTION');
    // Company sorts A–Z; the others newest/highest first. Announcing every
    // column as "descending" was simply untrue for one of them.
    expect(app).toContain("company: 'ascending'");
    expect(html).toContain('data-sort="company"');
    // Sortable headers are reachable and operable by keyboard.
    expect(html).toMatch(/<th class="sortable"[^>]*tabindex="0"/);
  });
});

describe('run state and recovery', () => {
  it('actually hides the elements the script hides', () => {
    // `button { display: inline-flex }` outranks the UA's `[hidden]` rule, so
    // <button hidden> kept rendering — "Cancel" sat in the header permanently,
    // offering to cancel a run that was not happening.
    expect(css).toContain('[hidden] { display: none !important; }');
    expect(html).toContain('id="btnCancel"');
    expect(app).toContain('cancel.hidden = !state.running;');
  });

  it('restores each run button real tooltip once the run finishes', () => {
    // The old code re-read button.title, which by then held "a run is in
    // progress", so these buttons never explained themselves again.
    expect(app).toContain('if (button.dataset.title === undefined) button.dataset.title = button.title;');
    expect(app).not.toContain('button.dataset.title ?? button.title');
  });

  it('polls run status and reloads once a run finishes', () => {
    expect(app).toContain('/api/run/status');
    expect(app).toContain('wasRunning');
    expect(app).toContain('refreshAll()');
  });

  it('supports cancelling a run and keeping finished work', () => {
    expect(app).toContain('/api/run/cancel');
    expect(app).toMatch(/finished work is kept/i);
  });

  it('reports per-source discovery progress', () => {
    expect(app).toContain('progress.currentSource');
  });

  it('gives a long run one region that owns every state', () => {
    // A discovery pass takes minutes across a dozen boards. It used to be one
    // truncated line — "discover running… 3/12 · greenhouse" clipped at 320px —
    // with no progress bar, no elapsed time, and no way to see which board was
    // slow or failing. One element now owns idle / running / ok / warn / error,
    // so the header cannot reflow as the state changes.
    expect(html).toContain('id="runbox"');
    for (const state of ['idle', 'running', 'ok', 'warn', 'error']) {
      expect(css, `no style for run state "${state}"`).toContain(`.runbox[data-state="${state}"]`);
    }
    expect(css).toContain('.runbox[data-state="idle"] { display: none; }');
  });

  it('names the run in the words the button used, not the internal phase', () => {
    expect(app).toContain('const PHASE_LABELS');
    expect(app).toContain("discover: 'Finding new jobs'");
    // "Find new jobs" is the button; "discover running…" was the old status.
    expect(app).not.toContain('running…`');
  });

  it('shows a determinate progress line, and motion only when there is no total', () => {
    expect(html).toContain('id="runline"');
    expect(css).toContain('.runline i');
    expect(css).toContain('.runline.indeterminate i');
    // A bar must not imply a fraction the server never reported.
    expect(app).toContain("line.classList.add('indeterminate')");
    expect(app).toContain('Math.min(100, Math.round((done / total) * 100))');
  });

  it('shows elapsed time and progress against the real total', () => {
    expect(app).toContain('function elapsedSince');
    expect(app).toContain('${progress.completed ?? 0} of ${progress.total} ${unit}');
  });

  it('surfaces the per-source breakdown and RCA the server already tracked', () => {
    // found counts, errors, duration, cached and status per board — plus the
    // structured failure explanations — had nowhere to appear, so a throttled
    // board looked exactly like one that returned nothing.
    expect(html).toContain('id="runDetails"');
    expect(html).toContain('data-action="toggle-run-details"');
    expect(app).toContain('function renderRunDetails');
    for (const field of ['item.found', 'item.errors', 'item.cached', 'item.durationMs', 'status.rca']) {
      expect(app, `run details ignore ${field}`).toContain(field);
    }
    // Dismissable, and a newer run's outcome still appears after a dismissal.
    expect(html).toContain('data-action="dismiss-run"');
    expect(app).toContain('state.runDismissedAt === finished');
  });

  it('explains WHY a source failed, not just what it cost', () => {
    // The classifier already produced a category, an HTTP status, the sanitized
    // provider message and per-category guidance. Rendering only `impact` meant
    // the panel said "16 results are missing" and never why.
    const render = app.slice(app.indexOf('function renderRunDetails'), app.indexOf('function applyRunGate'));
    for (const field of ['entry.category', 'entry.status', 'entry.message', 'entry.guidance', 'entry.impact']) {
      expect(render, `run details drop ${field}`).toContain(field);
    }
    expect(css).toContain('.run-why');
    expect(css).toContain('.run-fix');
  });

  it('groups the big counts a discovery run produces', () => {
    // "Found 14461" is materially harder to read than "Found 14,461".
    expect(app).toContain('`Found ${fmt(counters.jobs_found)}');
    expect(app).not.toMatch(/\$\{counters\.jobs_found \?\? 0\}/);
  });

  it('draws the connection dot once', () => {
    // The dot became a CSS pseudo-element; leaving it in the text too rendered
    // "● ● connected".
    expect(css).toContain('.conn::before');
    expect(app).toContain("conn.textContent = up ? 'connected' : 'disconnected';");
    expect(html).not.toContain('●');
  });

  it('reports skipped jobs in a batch result instead of hiding them', () => {
    expect(app).toContain('skipped');
    expect(app).toContain("result.skipped ?? []");
  });

  it('shows an offline banner and recovers automatically', () => {
    expect(html).toContain('id="offline"');
    expect(app).toContain('setServerStatus');
  });
});

describe('tailored resume review', () => {
  it('gives the resume a first-class, one-click preview path', () => {
    expect(app).toContain("'preview-resume'");
    expect(app).toContain('/resume-preview');
    expect(app).toContain('resume?format=pdf');
    expect(app).toContain('resume?format=docx');
    expect(app).toContain('function resumeCard');
  });

  it('explains what changed and what was deliberately not added', () => {
    expect(app).toContain('What was changed in your resume');
    expect(app).toContain('Asked for, but not in your resume');
    expect(app).toMatch(/deliberately NOT added/);
  });

  it('reports grounded requirement-analysis provenance when present', () => {
    expect(app).toContain('llmRequirements');
    expect(app).toMatch(/found verbatim in the job description/);
  });
});
