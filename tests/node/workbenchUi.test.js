import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../src/dashboard/public/index.html', import.meta.url), 'utf8');

describe('one-page workbench shell', () => {
  it('keeps the daily workflow on one page with horizontal tabs and a persistent right column', () => {
    expect(html).not.toContain('<nav class="rail"');
    expect(html).toContain('class="wf-tabs"');
    expect(html).toContain('Best matches');
    expect(html).toContain('Ready to apply');
    expect(html).toContain('class="right-col"');
    expect(html).toContain('Today\\u2019s priorities');
    expect(html).toContain('Match evidence');
  });

  it('exposes every primary command and keeps utility views in a drawer', () => {
    for (const label of [
      'Find new jobs', 'Re-score', 'Prepare', 'Auto-Apply Selected',
      'Auto-Apply Best', 'Add by URL', 'Interview Prep',
    ]) expect(html).toContain(label);
    expect(html).toContain('class="util-drawer"');
    expect(html).toContain('data-util="documents"');
    expect(html).toContain('data-util="analytics"');
    expect(html).toContain('Settings &amp; health');
  });

  it('requires an explicit one-run Auto-Apply consent and calls the preview API first', () => {
    expect(html).toContain('/api/auto-apply/eligibility');
    expect(html).toContain('id="auto-consent"');
    expect(html).toContain('explicitly authorize');
    expect(html).toContain('autoSubmit: true');
    expect(html).toContain('positive confirmation evidence');
  });

  it('contains responsive/mobile contracts and prevents page-level horizontal overflow', () => {
    expect(html).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
    for (const width of ['1280px', '1100px', '900px', '760px', '430px']) {
      expect(html).toContain(`max-width: ${width}`);
    }
    expect(html).toContain('.job-cards { display: block; }');
    expect(html).toContain('.main { margin-left: 0; padding-bottom: 0; }');
  });

  it('implements keyboard-operable tabs and traps focus inside modal utility drawers', () => {
    expect(html).toContain('aria-controls="job-results"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('["ArrowLeft", "ArrowRight", "Home", "End"]');
    expect(html).toContain('event.key === "Tab" && !$("util-drawer").hidden');
  });

  it('the inline application script parses and its HTML escape helper is effective', () => {
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();

    const from = script.indexOf('function h(value)');
    const to = script.indexOf('function enc(value)', from);
    const escape = new Function(`${script.slice(from, to)}; return h;`)();
    expect(escape('<img src=x onerror="boom"> &')).toBe('&lt;img src=x onerror=&quot;boom&quot;&gt; &amp;');
  });

  it('loads fresh statistics before re-rendering after a background run', () => {
    expect(html).toContain('state.stats = null; await loadStats(true); await renderWorkbench();');
    expect(html).not.toContain('state.stats = null; await renderWorkbench(); await loadStats(true);');
  });

  it('shows determinate source progress, elapsed time, and responsive cancellation state', () => {
    expect(html).toContain('id="run-bar"');
    expect(html).toContain('progress.currentSource');
    expect(html).toContain('duration(elapsed) + " elapsed"');
    expect(html).toContain('run.cancelRequested ? "Cancelling"');
    expect(html).toContain('run.lastResult.cancelled');
    expect(html).toContain('Source timings');
  });

  it('keeps compact filter checkboxes from inheriting full-width text-input flex rules', () => {
    expect(html).toMatch(/\.check-filter input\s*\{[^}]*flex:\s*0 0 14px;[^}]*min-width:\s*14px;/s);
  });
});
