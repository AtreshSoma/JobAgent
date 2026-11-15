/**
 * What the README, .env.example and User Guide promise must match the code
 * (audit 2026-11-14, X2, X3, X7).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const README = read('README.md');
const ENV_EXAMPLE = read('.env.example');
const GUIDE = read('docs/USER_GUIDE.md');
const SECURITY = read('SECURITY.md');

/** Every optional model feature, by the switch that turns it on. */
const MODEL_SWITCHES = ['LLM_ASSIST', 'RESUME_REWRITE', 'COVER_LETTER_MODE', 'INBOX_LLM', 'RERANK'];

describe('what reaches a model provider (X3, N1)', () => {
  it('the README no longer says only the posting is sent', () => {
    expect(README).not.toMatch(/Only the public job title and description are sent/);
    expect(README).not.toMatch(/Your resume and contact details are not\./);
  });

  for (const [name, text] of [['README', README], ['.env.example', ENV_EXAMPLE], ['User Guide', GUIDE], ['SECURITY.md', SECURITY]]) {
    it(`${name} names every model feature and what it sends`, () => {
      for (const flag of MODEL_SWITCHES) expect(text, `${name} mentions ${flag}`).toContain(flag);
      // Letters send summary paragraphs as well as bullets.
      expect(text).toMatch(/summary/i);
      // The name line and contact lines are never sent, by any feature.
      expect(text).toMatch(/name and contact (?:lines|details)[^.]*never sent|never sent[^.]*name and contact/i);
      // Two of them send resume text, so a local provider is recommended.
      expect(text).toMatch(/Ollama/);
      expect(text).toMatch(/LM Studio/);
    });
  }
});

describe('the README auto-submit gates (X2)', () => {
  const gates = README.slice(README.indexOf('The gates on the one automated submit path'), README.indexOf('</details>', README.indexOf('The gates on the one automated submit path')));
  const verified = JSON.parse(read('config/verified_live_ats.json')).verified ?? [];

  it('lists the live-verification gate', () => {
    expect(gates).toContain('config/verified_live_ats.json');
    expect(gates).toMatch(/LIVE_VERIFICATION\.md/);
  });

  it('the summary at the top names the live run too', () => {
    const summary = README.slice(README.indexOf('You stay in control of every application'), README.indexOf('## ', README.indexOf('You stay in control of every application')));
    expect(summary).toMatch(/live run/i);
  });

  it('the User Guide gate list names it too', () => {
    const line = GUIDE.split('\n').find((l) => l.includes('A fixture-verified ATS'));
    expect(line).toContain('verified_live_ats.json');
  });

  it('says plainly when no ATS has passed it', () => {
    if (verified.length === 0) expect(gates).toMatch(/no ATS has (?:passed|a recorded)[^.]*\. [^.]*refused on every ATS|refused on every ATS/i);
  });
});

describe('cross-company search providers (X7, N6)', () => {
  const NAMES = { workable: 'Workable', smartrecruiters: 'SmartRecruiters', themuse: 'The Muse' };
  const jobboards = JSON.parse(read('config/jobboards.json'));
  const providers = jobboards.sources.find((s) => s.id === 'ats-search')?.options?.providers ?? [];

  it('the README source table names every provider ats-search uses', () => {
    expect(providers.length).toBeGreaterThan(0);
    const row = README.split("\n").find((l) => l.startsWith("| **`ats-search`**"));
    for (const id of providers) {
      expect(NAMES[id], `display name for provider ${id}`).toBeTruthy();
      expect(row, `README ats-search row names ${NAMES[id]}`).toContain(NAMES[id]);
    }
  });

  it('the support matrix does not call an enabled provider rejected', () => {
    const matrix = read('docs/SUPPORT_MATRIX.md');
    const rejected = matrix.split('\n\n').filter((p) => /rejected on yield/i.test(p)).join(' ');
    for (const id of providers) expect(rejected, `${NAMES[id]} listed as rejected`).not.toMatch(new RegExp(`${NAMES[id]} \\d+ of \\d+`));
  });
});
