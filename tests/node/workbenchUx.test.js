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
