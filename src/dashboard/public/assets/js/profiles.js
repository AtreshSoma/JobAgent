/**
 * Search profiles: who the dashboard is searching as, and switching between
 * people. Shared by the header's Profile menu and the Master resume dialog.
 *
 * A profile switch rewrites the search configuration, so it is never silent:
 * every switch says who you are now searching as and offers "Switch back".
 * Deleting a profile always asks first and can never remove the active one
 * (the server refuses that too).
 */

import { $, el, toast } from './dom.js';
import { api, postJson } from './api.js';
import { confirmAction } from './dialogs.js';
import { scheduleRefresh } from './mutations.js';
import { displayName, initials } from './format.js';

/** The name to show for a listing row, falling back to its label without the " — search" suffix. */
export function profileName(p) {
  // A label reads "Name — Headline"; without a stored name, the part before
  // the dash is the name (it used to keep "Atresh — Senior Data Engineer",
  // shown as "Atresh, Senior Data Engineer" with the initials "AE").
  return displayName(p?.name) || displayName(String(p?.label ?? p?.id ?? '').split(/\s+[—–-]\s+/)[0]);
}

/** When a profile was created ("1 Nov, 18:36"), with seconds only if needed to tell two apart. */
function savedAt(iso, { seconds = false } = {}) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  });
}

/**
 * The listing, with each profile's display name, readiness and — only where two
 * share a name — the moment it was saved, so identical rows become tellable.
 */
export function describeProfiles(listing) {
  const rows = (listing?.profiles ?? []).filter((p) => !p.error).map((p) => ({
    ...p, display: profileName(p), ready: (p.targetRoles ?? []).length > 0,
  }));
  const counts = new Map();
  for (const r of rows) counts.set(r.display.toLowerCase(), (counts.get(r.display.toLowerCase()) ?? 0) + 1);
  for (const r of rows) r.duplicate = counts.get(r.display.toLowerCase()) > 1;
  // Two copies made in the same minute (a double click) need the seconds.
  const minutes = new Map();
  for (const r of rows.filter((x) => x.duplicate)) {
    const key = `${r.display.toLowerCase()}|${savedAt(r.createdAt)}`;
    minutes.set(key, (minutes.get(key) ?? 0) + 1);
  }
  for (const r of rows.filter((x) => x.duplicate)) {
    r.when = savedAt(r.createdAt, { seconds: minutes.get(`${r.display.toLowerCase()}|${savedAt(r.createdAt)}`) > 1 });
  }
  // Active first, then the most recently changed.
  return rows.sort((a, b) => Number(b.active) - Number(a.active));
}

/** One line under a name: the headline, or why the profile cannot search. */
export function profileSubline(p) {
  const parts = [p.ready ? (p.headline || p.targetRoles?.[0]) : 'No job titles yet, so it cannot search'].filter(Boolean);
  if (p.duplicate && p.when) parts.push(`created ${p.when}`);
  return parts.join(' · ');
}

let listingCache = null;

/** Fetch the listing; every caller that changes profiles calls this afterwards. */
export async function loadProfiles() {
  try { listingCache = await api('/api/search-profiles'); } catch { listingCache = null; }
  renderProfileMenu(listingCache);
  return listingCache;
}

/**
 * The header's Profile menu: one radio item per person, and the active
 * person's initials on the menu button itself, so who the dashboard is
 * searching as is visible from every screen.
 */
export function renderProfileMenu(listing) {
  const host = $('profileMenuItems');
  if (!host) return;
  const rows = describeProfiles(listing);
  // Always shown once there is a profile: "Add profile…" sits under the people,
  // so adding the second person is as findable as switching to them.
  const show = rows.length > 0;
  host.replaceChildren();
  $('profileMenuLabel').hidden = !show;
  if (show) {
    for (const p of rows) {
      host.append(el('button', {
        type: 'button', role: 'menuitemradio', class: 'pf-menuitem',
        'aria-checked': String(p.active), 'data-action': 'activate-search-profile', 'data-profile-id': p.id,
        disabled: !p.ready && !p.active,
        title: p.ready ? '' : 'This profile has no job titles yet, so it cannot search',
      },
      el('span', { class: 'pf-avatar', 'aria-hidden': 'true', text: initials(p.display) || '?' }),
      el('span', { class: 'pf-mi-text' },
        el('span', { class: 'pf-mi-name', text: p.display }),
        el('span', { class: 'pf-mi-sub', text: p.active ? 'Active' : profileSubline(p) }))));
    }
  }
  const active = rows.find((p) => p.active);
  // Who the empty states and titles speak to ("No jobs yet for Morgan").
  document.body.dataset.person = active?.display ?? '';
  document.body.dataset.people = String(rows.length);
  // An empty state drawn before this list arrived could not yet say whose it is.
  const first = rows.length > 1 ? (active?.display ?? '').split(' ')[0] : '';
  if (first) {
    const board = document.querySelector('#rows .empty .big');
    if (board?.textContent === 'No jobs yet') board.textContent = `No jobs yet for ${first}`;
    const today = document.querySelector('.today-empty .big');
    if (today?.textContent === 'Nothing needs you right now') today.textContent = `Nothing needs ${first} right now`;
  }
  const button = document.querySelector('[data-action="toggle-account-menu"]');
  const avatar = $('profileAvatar');
  if (button && avatar) {
    const who = active?.display ?? '';
    avatar.textContent = initials(who);
    avatar.hidden = !who;
    button.classList.toggle('has-avatar', Boolean(who));
    const label = who ? `Profile: ${who}. Switch profile, resume and preferences` : 'Profile, resume and preferences';
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

/** Re-render whatever shows profiles, and the data that depends on the active one. */
async function afterChange() {
  await loadProfiles();
  if ($('dlgMaster')?.open) {
    const { renderMasterResume } = await import('./master.js');
    await renderMasterResume();
    $('mrSearchHead')?.focus();
  }
}

/**
 * Switch the search to another person's profile, with a one-click way back.
 *
 * @param {string} id profile to activate
 * @param {{ quiet?: boolean }} [options] quiet: no "Switch back" (it IS the switch back)
 */
export async function switchProfile(id, { quiet = false } = {}) {
  const before = listingCache?.activeId ?? null;
  if (!id || id === before) return;
  const r = await postJson('/api/search-profiles/activate', { id });
  if (r.workspaceChanged) { reloadAsNewPerson(r.label, quiet ? null : before); return; }
  scheduleRefresh(0);
  await afterChange();
  announceSwitch(r.label, quiet ? null : before);
}

const SWITCHED_KEY = 'jobagent.switched';

/**
 * A different person means a different database: every tab, the open job,
 * the selection and the counts all belong to the previous person. A reload is
 * the one way to be certain nothing of theirs survives on screen; the
 * "Now searching as … [Switch back]" notice is carried across it.
 */
export function reloadAsNewPerson(label, previousId) {
  try { sessionStorage.setItem(SWITCHED_KEY, JSON.stringify({ label, previousId })); } catch { /* storage off: no notice, still correct */ }
  location.reload();
}

/** After that reload: say who you are searching as now. */
export function announcePendingSwitch() {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(SWITCHED_KEY) ?? 'null');
    sessionStorage.removeItem(SWITCHED_KEY);
  } catch { pending = null; }
  if (pending?.label) announceSwitch(pending.label, pending.previousId ?? null);
}

/** The id of the profile being searched as, from the last listing (null if unknown). */
export const activeProfileId = () => listingCache?.activeId ?? null;

/**
 * "Now searching as X", with a one-click "Switch back" to `previousId` — the
 * same toast for every path that changes who is active (the list, the header
 * menu, creating a profile from a resume).
 *
 * @param {string} label the newly active profile's label
 * @param {string|null} previousId where "Switch back" goes; null for no button
 */
export function announceSwitch(label, previousId) {
  const who = displayName(String(label ?? '').replace(/\s+[—-]\s+.*$/, '')) || label;
  if (!previousId) { toast(`Now searching as ${who}.`, 'good'); return; }
  const before = previousId;
  const node = el('div', { class: 'toast good undo-toast', role: 'status' },
    el('span', { text: `Now searching as ${who}.` }));
  const back = el('button', { type: 'button', class: 'small', text: 'Switch back' });
  back.addEventListener('click', async () => {
    back.disabled = true;
    try { await switchProfile(before, { quiet: true }); node.remove(); }
    catch (err) { back.disabled = false; toast(err.message, 'bad'); }
  });
  node.append(back);
  $('toasts').append(node);
  setTimeout(() => node.remove(), 10000);
}

/** Delete a saved (inactive) profile after asking. */
export function deleteProfileAsk(id) {
  const p = describeProfiles(listingCache).find((row) => row.id === id);
  const name = p ? `${p.display}${p.duplicate && p.when ? ` (created ${p.when})` : ''}` : id;
  confirmAction(
    `Delete the saved profile "${name}"?\n`
    + '  Its search goals are removed from this computer. The resume file, your jobs and your other profiles are not touched.',
    async () => {
      await api(`/api/search-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(`Deleted ${name}.`, 'good');
      await afterChange();
    },
  );
}

/* ─────────────────────── add or edit a person ─────────────────────── */

const form = {
  mode: 'add', id: null, roles: [], resumeBase64: null, phone: '',
};

const MAX_ROLES = 15;

function renderRoleChips() {
  const list = $('personRoleList');
  list.replaceChildren();
  for (const [i, role] of form.roles.entries()) {
    list.append(el('li', { class: 'chip role-chip' }, el('span', { text: role }),
      el('button', {
        type: 'button', class: 'role-chip-x', 'data-action': 'remove-role', 'data-index': String(i),
        'aria-label': `Remove ${role}`, title: `Remove ${role}`,
      }, '×')));
  }
}

/** Add one or several (comma- or line-separated) titles, keeping order and dropping repeats. */
export function addRoles(text) {
  for (const raw of String(text ?? '').split(/[,\n;]/)) {
    const role = raw.replace(/\s+/g, ' ').trim();
    if (!role || form.roles.length >= MAX_ROLES) continue;
    if (form.roles.some((r) => r.toLowerCase() === role.toLowerCase())) continue;
    form.roles.push(role);
  }
  renderRoleChips();
  setFieldError('Roles', '');
}

export function removeRole(index) {
  form.roles.splice(Number(index), 1);
  renderRoleChips();
  $('personRoleInput').focus();
}

function setFieldError(key, message) {
  const node = $(`person${key}Error`);
  const input = key === 'Roles' ? $('personRoleInput') : $(`person${key}`);
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
  input?.setAttribute('aria-invalid', String(Boolean(message)));
}

function fillForm(values = {}) {
  $('personName').value = displayName(values.fullName ?? '');
  $('personEmail').value = values.email ?? '';
  $('personCity').value = values.city ?? '';
  $('personState').value = values.state ?? '';
  $('personSeniority').value = values.seniority ?? '';
  $('personRemote').checked = values.remoteOnly === true;
  form.roles = [];
  form.phone = values.phone ?? '';
  addRoles((values.targetRoles ?? []).join(','));
  for (const key of ['Name', 'Email', 'Roles', 'Form']) setFieldError(key, '');
}

/** Open the form to add a person (optionally pre-filled from a resume already in hand). */
export async function openAddProfile({ file = null } = {}) {
  Object.assign(form, { mode: 'add', id: null, resumeBase64: null });
  $('dlgPersonTitle').textContent = 'Add a profile';
  $('dlgPersonSub').textContent = 'Each person gets their own jobs, resume and applications.';
  $('personSave').textContent = 'Add profile';
  $('personResumeRow').hidden = false;
  $('personActivateRow').hidden = false;
  $('personActivate').checked = true;
  $('personResumeStatus').textContent = 'Optional. A .docx file; it becomes their own master resume.';
  fillForm({});
  const { openDialog } = await import('./dialogs.js');
  openDialog($('dlgPerson'));
  $('personName').focus();
  if (file) await readResumeIntoForm(file);
}

/** Open the form to edit a saved person. */
export async function openEditProfile(id) {
  const data = await api(`/api/search-profiles/${encodeURIComponent(id)}`);
  const p = data.profile;
  Object.assign(form, { mode: 'edit', id, resumeBase64: null });
  $('dlgPersonTitle').textContent = `Edit ${displayName(p.identity.fullName) || 'profile'}`;
  $('dlgPersonSub').textContent = 'Changes to job titles apply to the next search.';
  $('personSave').textContent = 'Save changes';
  $('personResumeRow').hidden = true;
  $('personActivateRow').hidden = true;
  fillForm({
    fullName: p.identity.fullName, email: p.contact.email, phone: p.contact.phone,
    city: p.location.city, state: p.location.state, seniority: p.searchIntent.seniority,
    targetRoles: p.searchIntent.targetRoles,
    remoteOnly: (p.searchIntent.workModes ?? []).length === 1 && p.searchIntent.workModes[0] === 'remote',
  });
  const { openDialog } = await import('./dialogs.js');
  openDialog($('dlgPerson'));
  $('personName').focus();
}

/** Read a chosen .docx into the form. Nothing is saved until "Add profile". */
export async function readResumeIntoForm(file) {
  const status = $('personResumeStatus');
  if (!file) return;
  if (!/\.docx$/i.test(file.name)) { status.textContent = 'Only .docx files can be read. Save it as .docx and try again.'; return; }
  status.textContent = `Reading ${file.name}…`;
  try {
    const { bytesToBase64 } = await import('./master.js');
    const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const r = await postJson('/api/search-profiles/read-resume', { contentBase64 });
    form.resumeBase64 = contentBase64;
    // Keep anything already typed; fill only what is empty.
    const typed = { fullName: $('personName').value, email: $('personEmail').value };
    fillForm({
      ...r.fields,
      fullName: typed.fullName || r.fields.fullName,
      email: typed.email || r.fields.email,
      targetRoles: [...form.roles, ...(r.fields.targetRoles ?? [])],
    });
    const found = [r.found.roles && `${r.found.roles} job title${r.found.roles === 1 ? '' : 's'}`,
      r.found.jobs && `${r.found.jobs} past job${r.found.jobs === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    status.textContent = found ? `Read ${found} from ${file.name}. Check them below.` : `Read ${file.name}. No job titles found; add them below.`;
  } catch (err) {
    form.resumeBase64 = null;
    status.textContent = err.message;
  }
}

/** Submit the form: field errors in place, or save (and switch, when asked). */
export async function savePerson() {
  const leftover = $('personRoleInput').value;
  if (leftover.trim()) { addRoles(leftover); $('personRoleInput').value = ''; }
  const fields = {
    fullName: $('personName').value, email: $('personEmail').value, phone: form.phone,
    targetRoles: form.roles, city: $('personCity').value, state: $('personState').value,
    seniority: $('personSeniority').value, remoteOnly: $('personRemote').checked,
  };
  for (const key of ['Name', 'Email', 'Roles', 'Form']) setFieldError(key, '');
  const before = listingCache?.activeId ?? null;
  try {
    const r = form.mode === 'add'
      ? await postJson('/api/search-profiles', {
        fields, activate: $('personActivate').checked,
        ...(form.resumeBase64 ? { resume: { contentBase64: form.resumeBase64 } } : {}),
      })
      : await api(`/api/search-profiles/${encodeURIComponent(form.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
      });
    const { closeDialog } = await import('./dialogs.js');
    closeDialog($('dlgPerson'));
    if (r.workspaceChanged) { reloadAsNewPerson(r.activated?.label ?? fields.fullName, before); return; }
    toast(form.mode === 'add' ? `Added ${displayName(fields.fullName)}.` : 'Saved.', 'good');
    if (r.active) scheduleRefresh(0);
    await afterChange();
  } catch (err) {
    const fieldErrors = err.body?.fields ?? null;
    if (fieldErrors) {
      const map = { fullName: 'Name', email: 'Email', targetRoles: 'Roles' };
      for (const [k, v] of Object.entries(fieldErrors)) if (map[k]) setFieldError(map[k], v);
      const first = Object.keys(fieldErrors).map((k) => map[k]).find(Boolean);
      (first === 'Roles' ? $('personRoleInput') : $(`person${first}`))?.focus();
    } else {
      setFieldError('Form', err.message);
    }
  }
}

/* The chip input's keys: Enter or comma adds, Backspace on an empty field removes the last. */
$('personRoleInput')?.addEventListener('keydown', (event) => {
  const input = event.target;
  if (event.key === 'Enter' || event.key === ',') {
    if (!input.value.trim()) return; // an empty Enter submits the form
    event.preventDefault();
    addRoles(input.value);
    input.value = '';
  } else if (event.key === 'Backspace' && !input.value && form.roles.length) {
    form.roles.pop();
    renderRoleChips();
  }
});
$('personRoleInput')?.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text') ?? '';
  if (!/[,\n;]/.test(text)) return;
  event.preventDefault();
  addRoles(text);
});
$('personResumeFile')?.addEventListener('change', (event) => readResumeIntoForm(event.target.files?.[0]));
