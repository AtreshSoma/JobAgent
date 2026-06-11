/**
 * Live DOM form scanner.
 *
 * Reads the *actual* fields rendered on the current application page (inputs,
 * textareas, selects, radio groups, checkboxes) so the assistant can fill forms
 * it did not know about ahead of time — multi-step ATS flows, custom questions,
 * etc. This is deliberately READ-ONLY: it reports what it sees and never types,
 * clicks, or submits. All filling is done downstream by the type-aware filler,
 * which only ever writes values sourced from the candidate profile / config
 * screening answers.
 *
 * The scan runs in the page via `page.evaluate`. If the page object has no
 * `evaluate` (e.g. a unit-test fake), `scanFields` returns an empty list so
 * callers degrade gracefully instead of throwing.
 */

/**
 * Browser-side collector. Serialized and executed inside the page by Playwright.
 * Returns a plain array of field descriptors (no DOM handles cross the bridge).
 * @returns {Array<object>}
 */
/* c8 ignore start - executes in the browser, not under node coverage */
function collectFields() {
  const MAX_FIELDS = 120;

  const cssEscape = (s) =>
    (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // Best-effort human label for a control.
  const labelFor = (el) => {
    // 1. <label for="id">
    if (el.id) {
      const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    // 2. Wrapping <label>
    const wrap = el.closest('label');
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    // 3. aria-label / aria-labelledby
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref && ref.textContent.trim()) return ref.textContent.trim();
    }
    // 4. placeholder / name
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim();
    return (el.name || '').trim();
  };

  // Stable, unique-ish selector for a control.
  const selectorFor = (el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    if (el.name) {
      const tag = el.tagName.toLowerCase();
      const same = document.querySelectorAll(`${tag}[name="${cssEscape(el.name)}"]`);
      if (same.length === 1) return `${tag}[name="${cssEscape(el.name)}"]`;
      if (el.type) return `${tag}[name="${cssEscape(el.name)}"][type="${el.type}"]`;
      return `${tag}[name="${cssEscape(el.name)}"]`;
    }
    return null;
  };

  const out = [];
  const seenRadioGroups = new Set();
  const controls = Array.from(document.querySelectorAll('input, textarea, select'));

  for (const el of controls) {
    if (out.length >= MAX_FIELDS) break;
    const tag = el.tagName.toLowerCase();
    const rawType = (el.getAttribute('type') || tag).toLowerCase();

    // Skip controls we must never touch automatically.
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password'].includes(rawType)) continue;
    if (el.disabled || el.readOnly) continue;
    if (!isVisible(el)) continue;

    if (tag === 'select') {
      const options = Array.from(el.options || []).map((o) => ({
        value: o.value, label: (o.textContent || '').trim(),
      }));
      const sel = selectorFor(el);
      if (sel) out.push({ kind: 'select', type: 'select', selector: sel, label: labelFor(el), name: el.name || '', required: el.required === true, options });
      continue;
    }

    if (rawType === 'radio') {
      const groupKey = `${el.name || ''}`;
      if (!el.name || seenRadioGroups.has(groupKey)) continue;
      seenRadioGroups.add(groupKey);
      const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${cssEscape(el.name)}"]`));
      const options = radios.map((r) => ({
        value: r.value,
        label: labelFor(r) || r.value,
        selector: `input[type="radio"][name="${cssEscape(el.name)}"][value="${cssEscape(r.value)}"]`,
      }));
      out.push({ kind: 'radio', type: 'radio', selector: null, label: labelFor(el) || el.name, name: el.name, required: el.required === true, options });
      continue;
    }

    if (rawType === 'checkbox') {
      const sel = selectorFor(el);
      if (sel) out.push({ kind: 'checkbox', type: 'checkbox', selector: sel, label: labelFor(el), name: el.name || '', required: el.required === true, options: [] });
      continue;
    }

    // text-like inputs + textarea
    const sel = selectorFor(el);
    if (!sel) continue;

    // Detect typeahead / autocomplete / combobox widgets (e.g. Greenhouse's
    // "Location (City)" react-select). These look like a plain text input but
    // a plain fill() never commits the dropdown choice, so the form treats the
    // field as empty. Tagging them 'combobox' lets the filler type then pick an
    // option. Textareas are never comboboxes.
    const role = (el.getAttribute('role') || '').toLowerCase();
    const ariaAuto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
    const inReactSelect = !!el.closest('[class*="select__"], [class*="react-select"]');
    const hasList = !!el.getAttribute('list');
    const isCombobox = tag !== 'textarea' && (
      role === 'combobox' || ariaAuto === 'list' || ariaAuto === 'both' || inReactSelect || hasList
    );

    let listboxSelector = null;
    if (isCombobox) {
      const owns = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      if (owns) listboxSelector = `#${cssEscape(owns)}`;
    }

    out.push({
      kind: tag === 'textarea' ? 'textarea' : (isCombobox ? 'combobox' : 'text'),
      type: rawType,
      selector: sel,
      label: labelFor(el),
      name: el.name || '',
      required: el.required === true,
      options: [],
      ...(isCombobox ? { listboxSelector } : {}),
    });
  }

  return out;
}
/* c8 ignore stop */

/**
 * Scan the current page for fillable form fields.
 *
 * @param {object} page Playwright page (must expose `evaluate`) or a fake.
 * @returns {Promise<Array<{kind:string,type:string,selector:string|null,label:string,name:string,required:boolean,options:Array}>>}
 */
export async function scanFields(page) {
  if (!page || typeof page.evaluate !== 'function') return [];
  try {
    const fields = await page.evaluate(collectFields);
    return Array.isArray(fields) ? fields : [];
  } catch {
    return [];
  }
}

/**
 * URL patterns of known ATS application forms that are commonly EMBEDDED inside
 * a host careers page via an <iframe> (e.g. dropbox.com / samsara.com embedding
 * a Greenhouse form). When a page does this, `page.locator`/`page.evaluate` only
 * see the empty host document, so the assistant fills nothing. We detect the
 * embedded form frame and run all scanning/filling/uploading against it instead.
 */
const ATS_FRAME_RE = /(greenhouse\.io|grnhse|lever\.co|myworkdayjobs|ashbyhq|icims|jobvite|smartrecruiters|workable|bamboohr|breezy\.hr|teamtailor)/i;

/**
 * Resolve the frame that actually contains the application form.
 *
 * If the form lives in an embedded ATS iframe, returns that Playwright `Frame`
 * (which exposes the same `locator`/`evaluate`/`getByRole` API as a Page, so it
 * is a drop-in scope for the fillers). Otherwise — including unit-test fakes
 * with no `frames()` — returns the page unchanged.
 *
 * Embedded ATS iframes load asynchronously, so a single look at `page.frames()`
 * can race the iframe's navigation and silently fall back to the (empty) host
 * document. We therefore poll briefly: as long as an ATS-looking embed exists
 * but has no scannable fields yet, or a child frame is still on about:blank,
 * retry until `timeoutMs` elapses. Pages with no embeds return immediately.
 *
 * @param {object} page Playwright page (or a fake)
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] how long to wait for an embed to load
 * @param {number} [options.pollMs=150] delay between polls
 * @returns {Promise<object>} the page or an embedded form frame
 */
export async function resolveFormScope(page, { timeoutMs = 3000, pollMs = 150 } = {}) {
  if (!page || typeof page.frames !== 'function') return page;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let frames;
    try { frames = page.frames(); } catch { return page; }
    if (!Array.isArray(frames) || frames.length === 0) return page;

    // Only consider CHILD frames (skip the main frame). Track which look like
    // an embedded ATS form and which haven't navigated anywhere yet.
    const embeds = [];
    let pendingChild = false;
    for (const f of frames) {
      if (!f || typeof f.parentFrame !== 'function') continue;
      let parent = null;
      try { parent = f.parentFrame(); } catch { continue; }
      if (!parent) continue;
      let url = '';
      try { url = f.url() || ''; } catch { url = ''; }
      if (ATS_FRAME_RE.test(url)) embeds.push(f);
      else if (url === '' || url === 'about:blank') pendingChild = true;
    }

    for (const frame of embeds) {
      try {
        const fields = await scanFields(frame);
        if (fields.length > 0) return frame;
      } catch { /* try the next embed */ }
    }

    // Nothing fillable yet. If no embed exists (and none could still appear),
    // this is a plain top-level form — return the page without waiting.
    if (embeds.length === 0 && !pendingChild) return page;
    if (Date.now() >= deadline) return page;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

