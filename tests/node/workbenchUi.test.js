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
    expect(html).toContain('Job ID:');
    expect(html).toContain('copyJobId(this)');
    expect(html).toContain("history.replaceState(null, '', `#job=${encodeURIComponent(id)}`)");
    expect(html).toContain('const initialJobId = jobIdFromHash()');
    expect(html).toContain('if (initialJobId) select(initialJobId)');
    expect(html).toContain('Source performance');
    expect(html).toContain('Sponsorship feasibility');
    expect(html).toContain('Daily progress (last 7 days)');
  });

  it('keeps the complete primary workflow in the restored header and selection bar', () => {
    for (const label of [
      'Find New Jobs', 'Re-score', 'Auto-Prepare Best', 'Add by URL',
      'Interview Prep', 'Reports', 'Auto-fill', 'Prepare selected', 'Approve',
    ]) expect(html).toContain(label);
  });

  it('retains the newer cancellation and per-source discovery progress behavior', () => {
    expect(html).toContain('id="btnCancel"');
    expect(html).toContain('/api/run/cancel');
    expect(html).toContain('p.currentSource');
    expect(html).toContain('completed results will be kept');
    expect(html).toContain('cancelled · completed results kept');
  });

  it('keeps primary Auto-fill fill-only and retains verified manual submission safety', () => {
    expect(html).not.toContain('askAutoSubmit');
    expect(html).not.toContain('authorizedAutoSubmitIds');
    expect(html).toContain('autoSubmit: false');
    expect(html).toContain('stops before Submit');
    expect(html).toContain('verified: Boolean(confirmation)');
    expect(html).toContain('not counted as applied yet');
  });

  it('shows a compact tailored-resume review and minimal discovery activity state', () => {
    expect(html).toContain('Tailored resume review');
    expect(html).toContain('What was updated');
    expect(html).toContain('toggleResumePreview');
    expect(html).toContain('closeResumePreview');
    expect(html).toContain('body.preview-open');
    expect(html).toContain('position: fixed; inset: 24px');
    expect(html).toContain('/resume?format=pdf');
    expect(html).toContain('/resume-preview');
    expect(html).toContain('Needs your evidence (not auto-added)');
    expect(html).toContain('Check link');
    expect(html).toContain('setDiscovering');
    expect(html).toContain("button.textContent = on ? 'Finding jobs' : 'Find New Jobs'");
    expect(html).toContain('aria-live="polite"');
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
