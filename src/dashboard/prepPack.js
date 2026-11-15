/**
 * Interview prep pack (audit F10).
 *
 * When an application reaches Interviewing, one page brings together what the
 * person needs to prepare: each requirement the posting names beside the
 * master-resume line that shows it, the requirements no line shows (the gaps
 * to prepare for), the conditions buried in the posting, and the documents
 * that were submitted.
 *
 * Everything here is QUOTED from what JobAgent already holds (the job detail's
 * evidence map, hidden clauses and document versions). No model is used and
 * nothing is written for the person.
 */

/**
 * @param {object} detail jobDetail(...) output
 * @param {{versions?: object[]}} [options] the job folder's document versions, oldest first
 */
export function buildPrepPack(detail = {}, { versions = [] } = {}) {
  const evidenceAvailable = Array.isArray(detail.evidence);
  const evidence = evidenceAvailable ? detail.evidence : [];
  const shown = evidence
    .filter((e) => (e.lines ?? []).length)
    .map((e) => ({ requirement: e.term, lines: e.lines }));
  const gaps = evidence
    .filter((e) => !(e.lines ?? []).length)
    .map((e) => ({ requirement: e.term, note: 'No line in your resume shows this.' }));
  const seen = new Set(gaps.map((g) => g.requirement.toLowerCase()));
  for (const u of detail.unlistedRequirements ?? []) {
    if (u.inResume || seen.has(String(u.phrase).toLowerCase())) continue;
    seen.add(String(u.phrase).toLowerCase());
    gaps.push({
      requirement: u.phrase,
      note: `The posting names it${u.preferred ? ' as preferred' : ''}; your resume does not mention it.`,
    });
  }

  // The submitted documents are the frozen version, else the newest one.
  const frozen = [...versions].reverse().find((v) => v.frozen) ?? null;
  const chosen = frozen ?? versions[versions.length - 1] ?? null;

  return {
    jobId: detail.id ?? null,
    company: detail.company ?? null,
    title: detail.title ?? null,
    url: detail.url ?? null,
    location: detail.location ?? null,
    pay: detail.pay?.label ?? null,
    appliedOn: detail.application?.appliedOn ?? null,
    evidenceAvailable,
    shown,
    gaps,
    conditions: (detail.clauses ?? []).map((c) => ({ label: c.label, quote: c.quote })),
    documents: chosen ? {
      version: chosen.n, at: chosen.at ?? null, frozen: Boolean(chosen.frozen),
      files: Object.values(chosen.files ?? {}).filter(Boolean),
    } : null,
    basis: 'Quoted from the posting, your master resume and your saved documents. No model was used and nothing was written for you.',
  };
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The pack as one printable page: plain HTML, every value escaped, no script.
 * @param {ReturnType<typeof buildPrepPack>} pack
 */
export function renderPrepPackHtml(pack) {
  const list = (items, render, empty) => (items.length
    ? `<ul>${items.map(render).join('')}</ul>` : `<p class="muted">${esc(empty)}</p>`);
  const facts = [pack.location, pack.pay ? `Pay: ${pack.pay}` : null, pack.appliedOn ? `Applied ${pack.appliedOn}` : null]
    .filter(Boolean).map(esc).join(' · ');
  const docs = pack.documents
    ? `<p>Version ${esc(pack.documents.version)}${pack.documents.frozen ? ' (as submitted)' : ' (newest; no version was marked submitted)'}: ${pack.documents.files.map(esc).join(', ') || 'no files'}</p>`
    : '<p class="muted">No saved document versions for this job.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interview prep: ${esc(pack.company)} ${esc(pack.title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --rule: #d8d8dc; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf0; --muted: #a8a8b0; --rule: #3a3a40; --bg: #18181b; } }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); max-width: 760px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 24px 0 8px; border-bottom: 1px solid var(--rule); padding-bottom: 4px; }
  .muted { color: var(--muted); } ul { padding-left: 20px; } li { margin: 6px 0; } q { font-style: italic; }
  blockquote { margin: 4px 0 0; padding-left: 10px; border-left: 3px solid var(--rule); color: var(--muted); }
  @media print { body { margin: 0; max-width: none; } a { color: inherit; } }
</style></head><body>
<h1>${esc(pack.company)}: ${esc(pack.title)}</h1>
<p class="muted">${facts}${/^https?:\/\//i.test(String(pack.url ?? '')) ? ` · <a href="${esc(pack.url)}" rel="noopener">Posting</a>` : ''}</p>
<h2>What they ask for, and where your resume shows it</h2>
${pack.evidenceAvailable
    ? list(pack.shown, (s) => `<li><b>${esc(s.requirement)}</b>${s.lines.map((l) => `<blockquote>${esc(l)}</blockquote>`).join('')}</li>`, 'No requirement is shown by a line in your resume.')
    : '<p class="muted">Your master resume could not be read, so the lines that show each requirement are not available.</p>'}
<h2>Gaps to prepare for</h2>
${list(pack.gaps, (g) => `<li><b>${esc(g.requirement)}</b>: ${esc(g.note)}</li>`, 'None found.')}
<h2>Conditions in the posting</h2>
${list(pack.conditions, (c) => `<li><b>${esc(c.label)}</b><blockquote><q>${esc(c.quote)}</q></blockquote></li>`, 'None found.')}
<h2>What you submitted</h2>
${docs}
<p class="muted">${esc(pack.basis)}</p>
</body></html>
`;
}
