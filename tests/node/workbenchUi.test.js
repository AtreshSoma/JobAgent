import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../src/dashboard/public/index.html', import.meta.url), 'utf8');

describe('restored command-center workbench shell', () => {
  it('restores the compact dark dashboard requested by the user', () => {
    expect(html).toContain('<h1>JobAgent</h1>');
    expect(html).toContain('local-only · submit is your call');
    expect(html).toContain('class="ctxbar"');
    expect(html).toContain('class="tabs"');
    expect(html).toContain('id="tiles"');
    expect(html).toContain('id="rows"');
    expect(html).toContain('id="detail"');
    expect(html).toContain('Source performance');
    expect(html).toContain('Sponsorship feasibility');
    expect(html).toContain('Daily progress (last 7 days)');
  });

  it('keeps the complete primary workflow in the restored header and selection bar', () => {
    for (const label of [
      'Find New Jobs', 'Re-score', 'Auto-Prepare Best', 'Add by URL',
      'Interview Prep', 'Reports', 'Auto-apply', 'Prepare selected', 'Approve',
    ]) expect(html).toContain(label);
  });

  it('retains the newer cancellation and per-source discovery progress behavior', () => {
    expect(html).toContain('id="btnCancel"');
    expect(html).toContain('/api/run/cancel');
    expect(html).toContain('p.currentSource');
    expect(html).toContain('completed results will be kept');
    expect(html).toContain('cancelled · completed results kept');
  });

  it('retains auto-submit eligibility and verified-submission safety', () => {
    expect(html).toContain('/api/auto-apply/eligibility');
    expect(html).toContain('authorizedAutoSubmitIds');
    expect(html).toContain('autoSubmit: true');
    expect(html).toContain('verified: Boolean(confirmation)');
    expect(html).toContain('not counted as applied yet');
  });

  it('keeps responsive behavior without changing the restored desktop design', () => {
    expect(html).toMatch(/body\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(html).toContain('@media (max-width: 1180px)');
    expect(html).toContain('@media (max-width: 900px)');
    expect(html).toContain('header { align-items: flex-start; flex-wrap: wrap;');
  });

  it('parses the inline application script and escapes untrusted HTML', () => {
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();

    const from = script.indexOf('function esc(s)');
    const to = script.indexOf('/* ── tiles', from);
    const escape = new Function(`${script.slice(from, to)}; return esc;`)();
    expect(escape('<img src=x onerror="boom"> &')).toBe('&lt;img src=x onerror=&quot;boom&quot;&gt; &amp;');
  });

  it('refreshes stats and jobs after a background run completes', () => {
    expect(html).toContain('if (wasDown || (!s.running && wasRunning)) refresh();');
    expect(html).toContain('loadStats().then(loadSections)');
    expect(html).toContain('loadJobs().catch');
  });
});
