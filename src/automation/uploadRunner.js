/**
 * Upload runner.
 *
 * Attaches the tailored resume (and optional cover letter) to the file inputs
 * named in a packet's fill plan, using Playwright's `setInputFiles`. It verifies
 * each file exists before attaching and reports anything it could not resolve as
 * a blocker. It uploads only the artifacts the packet already prepared — it does
 * not fabricate or substitute documents.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Read the browser's live FileList after setInputFiles. A successful API call
 * alone is not enough: custom ATS widgets can immediately clear/reject a file.
 * `verified: null` means the page double does not expose FileList inspection;
 * real Playwright locators do.
 */
export async function verifyUploadAttached(locator, path) {
  if (!locator || typeof locator.evaluate !== 'function') {
    return { verified: null, verificationMethod: 'file-list-unavailable' };
  }
  try {
    const files = await locator.evaluate((input) => Array.from(input.files ?? []).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    })));
    const wanted = basename(path).toLowerCase();
    const match = Array.isArray(files) && files.some((file) => String(file?.name ?? '').toLowerCase() === wanted);
    return {
      verified: match,
      verificationMethod: 'input-file-list',
      attachedFileCount: Array.isArray(files) ? files.length : 0,
    };
  } catch (err) {
    return { verified: false, verificationMethod: 'input-file-list', verificationError: err.message };
  }
}

/**
 * What a file input is FOR, judged from the words around it.
 *
 * Cover letter is tested first: "Cover letter (optional, in addition to your
 * resume)" names both, and the slot is the cover letter's. A label naming
 * resume AND cover letter as alternatives ("Resume or cover letter") is
 * ambiguous and returns null.
 *
 * @param {string} text label / aria / nearby text / id / name
 * @returns {'resume'|'coverLetter'|'transcript'|'other'|null}
 */
export function classifyFileInput(text) {
  const t = String(text ?? '').toLowerCase().replace(/[_-]+/g, ' ');
  if (!t.trim()) return null;
  const cover = /\bcover\s*letter\b|\bmotivation(?:al)?\s*letter\b|\bcoverletter\b|\bcover\b/.test(t);
  const resume = /\bresume\b|\brésumé\b|\bcv\b|\bcurriculum\b/.test(t);
  if (cover && resume && /\b(?:resume|cv)\s*(?:\/|or|and)\s*cover|cover\s*letter\s*(?:\/|or|and)\s*(?:resume|cv)\b/.test(t)) return null;
  if (cover) return 'coverLetter';
  if (/\btranscripts?\b/.test(t)) return 'transcript';
  if (resume) return 'resume';
  if (/\b(?:portfolio|writing\s*sample|work\s*sample|certificat\w*|reference|photo|id\s*document|additional\s*(?:file|document)s?)\b/.test(t)) return 'other';
  return null;
}

/* c8 ignore start - executes in the browser, not under node coverage */
function collectFileInputs(hints) {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  inputs.forEach((el, index) => {
    const parts = [];
    for (const lab of Array.from(el.labels || [])) parts.push(text(lab));
    parts.push(el.getAttribute('aria-label') || '');
    for (const attr of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
        parts.push(text(document.getElementById(id)));
      }
    }
    const legend = el.closest('fieldset')?.querySelector('legend');
    if (legend) parts.push(text(legend));
    // Nearest ancestor that holds exactly this one file input: its own label
    // text (current Greenhouse renders "Resume/CV" in a sibling div, and hides
    // the input behind an "Attach" button).
    let box = el.parentElement;
    for (let depth = 0; box && depth < 4; depth += 1, box = box.parentElement) {
      if (box.querySelectorAll('input[type="file"]').length > 1) break;
      const lab = box.querySelector('label, legend, .label, [class*="label"], h3, h4');
      if (lab && text(lab)) { parts.push(text(lab).slice(0, 120)); break; }
    }
    parts.push(el.id || '', el.name || '', el.getAttribute('data-automation-id') || '',
      el.closest('[id]')?.id || '');
    const matches = [];
    for (const [type, sel] of Object.entries(hints || {})) {
      if (!sel) continue;
      try { if (el.matches(sel)) matches.push(type); } catch { /* not a DOM selector */ }
    }
    out.push({
      index,
      selector: `input[type="file"] >> nth=${index}`,
      text: parts.filter(Boolean).join(' | ').slice(0, 400),
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      hintFor: matches,
    });
  });
  return { fileInputs: out };
}
/* c8 ignore stop */

/**
 * Every file input on the page with the text that says what it is for.
 * Hidden inputs are included: modern ATS widgets hide the real input behind
 * an "Attach" button. Returns null when the page cannot be inspected (unit
 * doubles), in which case the static selectors are used as before.
 */
export async function discoverFileInputs(page, hints = {}) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    // Wrapped in an object so a page double whose evaluate() answers every
    // call with the same array can never be mistaken for a real inspection.
    const found = (await page.evaluate(collectFileInputs, hints))?.fileInputs;
    if (!Array.isArray(found)) return null;
    return found.map((f) => ({ ...f, kind: classifyFileInput(f.text) }));
  } catch {
    return null;
  }
}

/**
 * Pick the file input for one upload type.
 *
 * WHY. The static selectors were the whole decision, and several are generic
 * (`input[type="file"]` + `.first()`), so on a form whose FIRST file input was
 * the cover-letter slot the resume went into it — and a current Greenhouse
 * form (job-boards.greenhouse.io) matched none of the old `#resume_fieldset`
 * selectors at all. The words around each input now decide; a static selector
 * only breaks ties. An input that is clearly for something else is never used.
 *
 * @param {Array<object>} inputs discoverFileInputs() result
 * @param {string} type 'resume' | 'coverLetter'
 * @param {Set<number>} used indexes already taken by another upload
 * @returns {object|null} the chosen input, or null
 */
export function chooseFileInput(inputs, type, used = new Set()) {
  const free = inputs.filter((i) => !used.has(i.index));
  const labelled = free.filter((i) => i.kind === type);
  if (labelled.length) return labelled.find((i) => i.hintFor.includes(type)) ?? labelled[0];
  // No input says it is for this type. A resume may still go into the ONLY
  // file input on the page when nothing says it is for something else.
  const unlabelled = free.filter((i) => i.kind === null);
  if (type === 'resume' && inputs.length === 1 && unlabelled.length === 1) return unlabelled[0];
  // A static selector may pick an unlabelled input, never a labelled one.
  return unlabelled.find((i) => i.hintFor.includes(type)) ?? null;
}

/**
 * @param {object} page Playwright page (or compatible)
 * @param {object} fillPlan packet.fillPlan ({ uploads: [{type, path, selector}] })
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] resolve only; do not attach
 * @param {Function} [options.fileExists=existsSync]
 * @returns {Promise<{ uploaded: object[], blockers: string[], skipped: object[] }>}
 */
export async function uploadFiles(page, fillPlan = {}, { dryRun = false, fileExists = existsSync } = {}) {
  const uploads = Array.isArray(fillPlan.uploads) ? fillPlan.uploads : [];
  const uploaded = [];
  const blockers = [];
  const skipped = [];

  const hints = Object.fromEntries(uploads.filter((u) => u.selector).map((u) => [u.type, u.selector]));
  const discovered = await discoverFileInputs(page, hints);
  const used = new Set();

  for (const u of uploads) {
    if (!u.path) {
      skipped.push({ type: u.type, reason: 'no file path' });
      continue;
    }
    if (!fileExists(u.path)) {
      blockers.push(`${u.type}: file not found at ${u.path}`);
      continue;
    }
    if (discovered && discovered.length) {
      const chosen = chooseFileInput(discovered, u.type, used);
      if (!chosen) {
        const message = `${u.type}: upload input not found (no file input on this page is labelled for it)`;
        if (u.required === false) skipped.push({ type: u.type, path: u.path, reason: message });
        else blockers.push(message);
        continue;
      }
      used.add(chosen.index);
      if (dryRun) {
        skipped.push({ type: u.type, path: u.path, selector: chosen.selector, reason: 'dry run' });
        continue;
      }
      try {
        const locator = page.locator(chosen.selector);
        await locator.setInputFiles(u.path);
        const verification = await verifyUploadAttached(locator, u.path);
        uploaded.push({
          type: u.type, path: u.path, selector: chosen.selector,
          matchedBy: chosen.kind === u.type ? 'label' : 'selector-hint', ...verification,
        });
        if (verification.verified === false) {
          blockers.push(`${u.type}: upload did not remain attached after selection`);
        }
      } catch (err) {
        blockers.push(`${u.type}: upload failed (${err.message})`);
      }
      continue;
    }
    if (discovered && discovered.length === 0 && u.selector) {
      const message = `${u.type}: upload input not found (${u.selector})`;
      if (u.required === false) skipped.push({ type: u.type, path: u.path, selector: u.selector, reason: message });
      else blockers.push(message);
      continue;
    }
    if (!u.selector) {
      const message = `${u.type}: no upload selector resolved`;
      if (u.required === false) skipped.push({ type: u.type, path: u.path, reason: message });
      else blockers.push(message);
      continue;
    }
    let count = 0;
    try {
      count = await page.locator(u.selector).count();
    } catch {
      count = 0;
    }
    if (count < 1) {
      const message = `${u.type}: upload input not found (${u.selector})`;
      if (u.required === false) skipped.push({ type: u.type, path: u.path, selector: u.selector, reason: message });
      else blockers.push(message);
      continue;
    }
    if (dryRun) {
      skipped.push({ type: u.type, path: u.path, selector: u.selector, reason: 'dry run' });
      continue;
    }
    try {
      const locator = page.locator(u.selector).first();
      await locator.setInputFiles(u.path);
      const verification = await verifyUploadAttached(locator, u.path);
      uploaded.push({ type: u.type, path: u.path, selector: u.selector, ...verification });
      if (verification.verified === false) {
        blockers.push(`${u.type}: upload did not remain attached after selection`);
      }
    } catch (err) {
      blockers.push(`${u.type}: upload failed (${err.message})`);
    }
  }

  return { uploaded, blockers, skipped };
}
