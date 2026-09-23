/**
 * Behaviour of the 2026-09 dashboard upgrade, asserted against the shipped
 * source (the dashboard has no bundler and no DOM test harness; the same style
 * as workbenchUi.test.js). Each block names the problem it guards against.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../../src/dashboard/public/index.html');
const css = read('../../src/dashboard/public/assets/css/app.css');
const jsDir = new URL('../../src/dashboard/public/assets/js/', import.meta.url);
// Every module, in a stable order, so assertions do not care which file a
// function lives in.
const app = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort()
  .map((f) => readFileSync(new URL(f, jsDir), 'utf8')).join('\n');

describe('the detail rail survives refreshes (U1)', () => {
  it('reconciles keyed sections instead of clearing the rail', () => {
    expect(app).toContain('reconcileDetail(current, sections)');
    // Never moves a kept node: detaching blurs whatever it holds.
    expect(app).toContain('if (prev && keepSection(prev, key)) placed = prev;');
    expect(app).toContain("return node.contains(document.activeElement) || (key === 'notes' && note.isDirty());");
    expect(app).toContain('function carryOpenDetails');
    expect(app).toContain("el('details', { 'data-key': 'technical' })");
    // The link-check result is state, not DOM, so a redraw keeps it.
    expect(app).toContain('state.linkHealth.set(id, { tone, text });');
  });

  it('autosaves the note on a debounce, on blur, and when leaving the job', () => {
    expect(app).toContain('const NOTE_DEBOUNCE_MS');
    expect(app).toContain("if (event.target.id === 'noteBox') saveNote();");
    expect(app).toContain('if (id !== state.selectedId) flushNote();');
    expect(app).toContain('keepalive: true');
    for (const label of ["saved: 'Saved'", "dirty: 'Unsaved changes'", "saving: 'Saving…'"]) {
      expect(app).toContain(label);
    }
  });

  it('puts board focus back on the same row and control after a re-render', () => {
    expect(app).toContain('function captureRowFocus');
    expect(app).toMatch(/function renderRows\(jobs\) \{\s*const body = \$\('rows'\);\s*const focus = captureRowFocus\(\);/);
    expect(app).toContain('restoreRowFocus(focus);');
  });
});

describe('the detail is on screen at every width (U2)', () => {
  it('lets the rail stick, capped to the viewport', () => {
    expect(css).toContain('.layout > aside { align-self: stretch;');
    const rail = css.slice(css.indexOf('.rail-sticky {'));
    expect(rail).toMatch(/max-height: calc\(100vh - var\(--topbar-h/);
    expect(rail).toMatch(/overflow: auto/);
  });

  it('opens a modal sheet at <=1240px, with focus moved in and returned to the row', () => {
    expect(html).toContain('<dialog id="dlgDetail" class="detail-sheet"');
    expect(app).toContain("matchMedia('(max-width: 1240px)')");
    expect(app).toContain('if (user && isSheetLayout()) openDetailSheet(id);');
    expect(app).toContain("$('dlgDetailTitle').focus();");
    expect(app).toContain('(sheetReturnId && jobAnchor(sheetReturnId))?.focus();');
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*dialog\.detail-sheet/);
  });

  it('debounces keyboard-driven selection', () => {
    expect(app).toContain('selectJob(next, { defer: 120 })');
  });
});

describe('a click costs one write and one board read (U3)', () => {
  it('patches the row and rail from the decision response, then reloads only the board page', () => {
    const decide = app.slice(app.indexOf('async function decide(id, decision)'), app.indexOf('async function simpleAction'));
    expect(decide).toContain('applyDecisionLocally(id');
    expect(decide).toContain('scheduleRefresh()');
    expect(decide).not.toContain('refreshAll');
    const schedule = app.slice(app.indexOf('function scheduleRefresh('), app.indexOf('async function refreshAll'));
    expect(schedule).toContain('scheduleBoardReload(delay)');
    expect(schedule).not.toContain('loadSections');
    expect(schedule).not.toContain('loadProfileFlag');
  });

  it('fetches stats single-flight and at most once a minute unless forced', () => {
    expect(app).toContain('const STATS_MIN_INTERVAL_MS = 60_000;');
    expect(app).toContain('if (statsInFlight) return statsInFlight;');
    expect(app).toContain('if (!force && wait > 0)');
    // A stale (cached) response is labelled and refetched soon.
    expect(app).toContain('if (stats.stale)');
    expect(app).toContain('Showing cached numbers — recalculating');
  });

  it('reads sections only while Discovery health is open, one section at a time', () => {
    expect(app).toContain("if ($('analytics').hidden) return;");
    expect(app).toContain("api('/api/sections?only=blockedByReason')");
  });

  it('asks for slim board rows', () => {
    expect(app).toContain("params.set('fields', 'board');");
  });

  it('keeps one poll chain and backs off in a hidden tab', () => {
    expect(app).toContain('const gen = ++pollGen;');
    expect(app).toContain('if (gen !== pollGen) return;');
    expect(app).toContain('const HIDDEN_POLL_MS = 30_000;');
    expect(app).toContain("document.addEventListener('visibilitychange'");
  });

  it('shows how fresh the board is', () => {
    expect(html).toContain('id="boardStatus"');
    for (const text of ['Refreshing…', 'Updated just now', 's ago']) expect(app).toContain(text);
  });
});

describe('menus follow the menu-button pattern (U5)', () => {
  it('moves focus into the menu and around it with the keyboard', () => {
    expect(app).toContain('function openMenu(pop');
    expect(app).toContain("(focus === 'last' ? items.at(-1) : items[0])?.focus();");
    for (const key of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Escape'", "'Tab'"]) {
      expect(app).toContain(`event.key === ${key}`);
    }
    // Escape returns focus to the trigger; leaving the menu closes it.
    expect(app).toContain('closeMenu(pop, { returnFocus: true });');
    expect(app).toContain("wrap.addEventListener('focusout'");
  });

  it('keeps menu semantics valid', () => {
    expect(html).toContain('<hr role="separator">');
    expect(html).not.toMatch(/<hr>/);
    expect(html).toContain('id="columnToggles" role="group"');
  });

  it('returns focus to the trigger when a menu item opens a dialog', () => {
    expect(app).toContain("const menu = from?.closest?.('.menu-pop');");
  });
});
