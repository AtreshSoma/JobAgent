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

  // Controls that are on the page but are NOT the application: a site search
  // box, a cookie/consent banner, a newsletter or job-alert signup. Reporting
  // them as ordinary fields meant a JD landing page with a header search box
  // "had fields", so its "Apply now" button was never allowed as the way in,
  // and the filler typed the candidate's email into the newsletter form.
  const SEARCHY = /search|keyword|query|\bq\b|find.?jobs/i;
  const SIGNUP = /newsletter|subscribe|subscription|job.?alert|talent.?(?:community|network)|get.?notified|sign.?up.?for|mailing.?list/i;
  const incidentalReason = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const hint = [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
    if (type === 'search' || el.closest('[role="search"], search')) return 'search';
    // Bot traps: a text box no person can see or reach (Oracle Recruiting's
    // "honey-pot" sits in a zero-height, overflow-hidden row, aria-hidden and
    // tabindex=-1). Typing into one flags the application as a bot.
    if (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file'].includes(type)) {
      const trapHint = [el.name, el.id, el.className, el.getAttribute('autocomplete')].join(' ');
      if (/honey.?pot|bot.?trap|\bhp[_-]|leave.?(?:this.?)?(?:field.?)?(?:blank|empty)/i.test(trapHint)) return 'honeypot';
      if (el.closest('[aria-hidden="true"]') && el.tabIndex === -1) return 'honeypot';
      for (let up = el.parentElement, depth = 0; up && depth < 4; up = up.parentElement, depth += 1) {
        const st = window.getComputedStyle(up);
        const r = up.getBoundingClientRect();
        if (st.overflow !== 'visible' && (r.height < 2 || r.width < 2)) return 'honeypot';
      }
    }
    if (el.closest('header, nav, [role="banner"], [role="navigation"]') && SEARCHY.test(hint)) return 'search';
    if (el.closest('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i], [class*="gdpr" i]')) {
      return 'consent-banner';
    }
    const form = el.closest('form');
    const box = form || el.closest('[class*="newsletter" i], [id*="newsletter" i], [class*="subscribe" i]');
    if (box) {
      const text = [box.id, box.className, box.getAttribute('action'), box.getAttribute('aria-label'),
        (box.textContent || '').slice(0, 400)].join(' ');
      const size = box.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
      if (SIGNUP.test(text) && size <= 3) return 'signup';
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

    // Skip controls we must never touch automatically. File inputs ARE
    // reported (the workflow must see required uploads and verify attachments
    // persist) — but as kind:'file', which the text filler ignores; only
    // uploadRunner ever touches them.
    if (['hidden', 'submit', 'button', 'image', 'reset', 'password'].includes(rawType)) continue;
    if (el.disabled || el.readOnly) continue;
    // A STYLED checkbox/radio hides the real input (opacity 0, clipped, 0×0)
    // and draws its own box on the label. Oracle Recruiting's "I have read the
    // Important Privacy Information" is one: skipping it as invisible meant the
    // run never reported the required question, clicked Next, and only learnt
    // of it from "You need to agree to the terms and conditions."
    const styledChoice = (rawType === 'checkbox' || rawType === 'radio') && !isVisible(el)
      && (() => {
        const lab = (el.id && document.querySelector(`label[for="${cssEscape(el.id)}"]`)) || el.closest('label');
        return Boolean(lab && isVisible(lab) && lab.textContent.trim());
      })();
    if (!isVisible(el) && !styledChoice) continue;

    if (rawType === 'file') {
      // ATS file inputs frequently carry no id/name (e.g. inside a labelled
      // <fieldset>) — fall back to a container-scoped selector so the field
      // is still reported.
      let sel = selectorFor(el);
      if (!sel) {
        const host = el.closest('fieldset[id], [id]');
        sel = host ? `#${cssEscape(host.id)} input[type="file"]` : 'input[type="file"]';
        if (document.querySelectorAll(sel).length !== 1) sel = null;
      }
      const label = labelFor(el)
        || (el.closest('fieldset')?.querySelector('legend')?.textContent ?? '').trim();
      if (sel) out.push({ kind: 'file', type: 'file', selector: sel, label, name: el.name || '', required: el.required === true });
      continue;
    }

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
      const label = labelFor(el);
      // Custom widgets mark "required" with aria-required or a trailing "*"
      // on the label rather than the native attribute.
      const required = el.required === true || el.getAttribute('aria-required') === 'true'
        || /\*\s*$/.test(label);
      if (sel) {
        out.push({
          kind: 'checkbox', type: 'checkbox', selector: sel, label: label.replace(/\s*\*\s*$/, ''),
          name: el.name || '', required, options: [], ...(styledChoice ? { styled: true } : {}),
        });
      }
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

  // Tag (never drop) incidental controls, so callers decide what to ignore.
  for (const field of out) {
    let el;
    try { el = field.selector ? document.querySelector(field.selector) : null; } catch { el = null; }
    if (!el && field.kind === 'radio' && field.options?.[0]?.selector) {
      try { el = document.querySelector(field.options[0].selector); } catch { el = null; }
    }
    const reason = el ? incidentalReason(el) : null;
    if (reason) field.incidental = reason;
  }
  return out;
}
/* c8 ignore stop */

/**
 * The scanned fields that belong to the application itself (drops site
 * search, consent banners and newsletter/job-alert signups).
 *
 * @param {Array<object>} fields scanFields() result
 * @returns {Array<object>}
 */
export function applicationFields(fields = []) {
  return (Array.isArray(fields) ? fields : []).filter((f) => !f?.incidental);
}

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
      let parent;
      try { parent = f.parentFrame(); } catch { continue; }
      if (!parent) continue;
      let url;
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


/**
 * Detect visible validation errors on the current form step.
 *
 * ATSes surface rejection of a step as inline field errors rather than a
 * navigation failure, so after filling (and after every advance click) the
 * runner asks the live DOM for:
 *   - fields marked aria-invalid="true" (reported with their label), and
 *   - visible alert/error text (role="alert", .error/.field-error/.help-block,
 *     Greenhouse/Lever/Workday error classes).
 *
 * Returns [] on pages/frames that cannot evaluate (unit-test fakes) — the
 * check degrades gracefully, it never breaks a run.
 *
 * @param {object} scope Playwright Page or Frame
 * @returns {Promise<string[]>} human-readable error strings, deduplicated
 */
export async function detectValidationErrors(scope) {
  if (!scope || typeof scope.evaluate !== 'function') return [];
  try {
    const errors = await scope.evaluate(() => {
      const out = new Set();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelFor = (el) => {
        if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
        const id = el.getAttribute('aria-describedby');
        if (id) {
          const desc = document.getElementById(id.split(/\s+/)[0]);
          if (desc) return desc.textContent.trim();
        }
        return el.name || el.id || 'field';
      };
      for (const el of document.querySelectorAll('[aria-invalid="true"]')) {
        if (visible(el)) out.add(`invalid field: ${labelFor(el).slice(0, 80)}`);
      }
      const errorSel = '[role="alert"], .field-error, .error-message, .help-block.error, '
        + '.field_with_errors, .invalid-feedback, [data-automation-id*="error"]';
      // A screen-reader announcement is not a form error. Workday keeps a
      // visually hidden role="alert" that says "<Job title> page is loaded";
      // read as an error, it stopped every Workday run before "Apply".
      const screenReaderOnly = (el) => {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width <= 2 || r.height <= 2 || /rect\(0(px)?,?\s*0(px)?/.test(st.clip)
          || /inset\(\s*50%/.test(st.clipPath);
      };
      const ANNOUNCEMENT = /^(?:.*\bpage is loaded|loading\b.*|.*\bhas loaded|\d+ results?\b.*)$/i;
      for (const el of document.querySelectorAll(errorSel)) {
        const text = (el.textContent || '').trim();
        if (!visible(el) || !text || text.length > 200) continue;
        if (el.matches('[role="alert"]') && (screenReaderOnly(el) || ANNOUNCEMENT.test(text))) continue;
        out.add(text);
      }
      return [...out].slice(0, 10);
    });
    return Array.isArray(errors) ? errors : [];
  } catch {
    return [];
  }
}

/**
 * Labels of every VISIBLE required control that is still empty on this step.
 *
 * The auto-submit gate used to trust `requiredFieldsSatisfied`, which only
 * knows about fields in the packet's static plan — and with an empty plan (the
 * normal case for a dynamically scanned form) it was vacuously true, so a form
 * with a blank required question could be submitted. This asks the live DOM
 * instead: `[required]` and `[aria-required="true"]` controls, radio groups by
 * name, checkboxes by `checked`, file inputs by their FileList.
 *
 * @param {object} scope Playwright Page or Frame
 * @returns {Promise<string[]|null>} empty labels, or null when the scope cannot
 *   be inspected (unit-test doubles)
 */
export async function unfilledRequiredControls(scope) {
  if (!scope || typeof scope.evaluate !== 'function') return null;
  try {
    const missing = await scope.evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelOf = (el) => {
        if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const ref = document.getElementById(by.split(/\s+/)[0]);
          if (ref) return ref.textContent.trim();
        }
        return el.name || el.id || 'required field';
      };
      const out = [];
      const seenGroups = new Set();
      const controls = document.querySelectorAll(
        'input[required], select[required], textarea[required], [aria-required="true"]',
      );
      for (const el of controls) {
        const tag = el.tagName.toLowerCase();
        const type = String(el.getAttribute('type') || tag).toLowerCase();
        if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
        if (el.disabled) continue;
        if (type === 'radio') {
          if (!el.name || seenGroups.has(el.name)) continue;
          seenGroups.add(el.name);
          const group = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
          if (!group.some(visible)) continue;
          if (!group.some((r) => r.checked)) out.push(labelOf(el));
          continue;
        }
        if (!['input', 'select', 'textarea'].includes(tag)) {
          // An ARIA widget (radiogroup / combobox / listbox) marked required.
          if (!visible(el)) continue;
          const chosen = el.querySelector('[aria-checked="true"], [aria-selected="true"]')
            || (el.getAttribute('aria-valuetext') || '').trim()
            || el.querySelector('[class*="single-value"], [class*="singleValue"]');
          if (!chosen) out.push(labelOf(el));
          continue;
        }
        if (!visible(el)) continue;
        if (type === 'checkbox') { if (!el.checked) out.push(labelOf(el)); continue; }
        if (type === 'file') { if (!el.files || el.files.length === 0) out.push(labelOf(el)); continue; }
        if (!String(el.value ?? '').trim()) out.push(labelOf(el));
      }
      return [...new Set(out.map((l) => l.replace(/\s+/g, ' ').slice(0, 120)))];
    });
    return Array.isArray(missing) ? missing : null;
  } catch {
    return null;
  }
}
