/**
 * Search profiles: who the dashboard is searching as, and switching between
 * people. Shared by the header's Profile menu and the Master resume dialog.
 *
 * A profile switch rewrites the search configuration, so it is never silent:
 * every switch says who you are now searching as and offers "Switch back".
 * Removing a profile always asks first, names the person on its button, and
 * can never remove the active one (the server refuses that too).
 */

import { $, el, toast } from './dom.js';
import { api, postJson } from './api.js';
import { closeDialog, guardDialog, openDialog } from './dialogs.js';
import { formIsDirty, markClean, saveOnlyOnPurpose } from './forms.js';
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
  // "Remove profile…" once there is someone besides the active person.
  const remove = document.querySelector('.pf-remove-item');
  if (remove) remove.hidden = rows.filter((p) => !p.active).length === 0;
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
export function reloadAsNewPerson(label, previousId, note = '') {
  try { sessionStorage.setItem(SWITCHED_KEY, JSON.stringify({ label, previousId, note })); } catch { /* storage off: no notice, still correct */ }
  location.reload();
}

/** "Added 312 matching jobs from Atresh's list; scoring them now." — or nothing. */
export function seedNote(seeded) {
  const n = Number(seeded) || 0;
  if (!n) return '';
  const owner = (document.body.dataset.person ?? '').split(' ')[0];
  return `Added ${n} matching job${n === 1 ? '' : 's'}${owner ? ` from ${owner}'s list` : ''}; scoring them now.`;
}

/** After that reload: say who you are searching as now. */
export function announcePendingSwitch() {
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(SWITCHED_KEY) ?? 'null');
    sessionStorage.removeItem(SWITCHED_KEY);
  } catch { pending = null; }
  if (pending?.label) announceSwitch(pending.label, pending.previousId ?? null, pending.note ?? '');
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
export function announceSwitch(label, previousId, note = '') {
  const who = displayName(String(label ?? '').replace(/\s+[—-]\s+.*$/, '')) || label;
  const text = `Now searching as ${who}.${note ? ` ${note}` : ''}`;
  if (!previousId) { toast(text, 'good'); return; }
  const before = previousId;
  const node = el('div', { class: 'toast good undo-toast', role: 'status' },
    el('span', { text }));
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

/* ─────────────────────── remove a person ─────────────────────── */

/** The chosen radio in the Remove dialog, or null. */
const chosenRemoval = () => document.querySelector('#removeList input[name="removeId"]:checked');

function setRemoveError(message) {
  $('removeError').textContent = message;
  $('removeError').hidden = !message;
}

/** The button names who it removes, so the last click is never a guess. */
function nameRemoveButton() {
  const chosen = chosenRemoval();
  const who = chosen ? describeProfiles(listingCache).find((p) => p.id === chosen.value)?.display : '';
  $('removeGo').textContent = who ? `Remove ${who.split(' ')[0]}` : 'Remove profile';
  if (chosen) setRemoveError('');
}
$('removeList')?.addEventListener('change', nameRemoveButton);

/**
 * "Remove profile…": pick who, read what happens to their files, remove.
 * The person being searched as is never offered (the server refuses it too).
 *
 * @param {string} [preselect] a profile id to start with (the Master resume list's trash button)
 */
export async function openRemoveProfile(preselect) {
  if (!listingCache) await loadProfiles();
  const rows = describeProfiles(listingCache);
  const active = rows.find((p) => p.active);
  const others = rows.filter((p) => !p.active);
  const pick = preselect ?? (others.length === 1 ? others[0].id : null);
  $('removeList').replaceChildren(...others.map((p) => el('label', { class: 'pf-pick' },
    el('input', { type: 'radio', name: 'removeId', value: p.id, checked: p.id === pick }),
    el('span', { class: 'pf-avatar', 'aria-hidden': 'true', text: initials(p.display) || '?' }),
    el('span', { class: 'pf-pick-text' },
      el('span', { class: 'pf-pick-name', text: p.display }),
      el('span', { class: 'pf-pick-sub', text: profileSubline(p) })))));
  const note = $('removeActiveNote');
  note.textContent = active
    ? `${active.display} is not listed because you are searching as them. To remove that profile, switch to someone else first.`
    : '';
  note.hidden = !active;
  setRemoveError(others.length ? '' : 'There is no other profile to remove.');
  nameRemoveButton();
  openDialog($('dlgRemovePerson'));
  // Start on the chosen person, else the first; never on the Remove button.
  (chosenRemoval() ?? $('removeList').querySelector('input'))?.focus();
}

/** Remove the chosen person: their profile and their own workspace are archived, never erased. */
export async function removePerson() {
  const chosen = chosenRemoval();
  if (!chosen) {
    setRemoveError('Choose the profile to remove.');
    $('removeList').querySelector('input')?.focus();
    return;
  }
  const p = describeProfiles(listingCache).find((row) => row.id === chosen.value);
  const name = p ? `${p.display}${p.duplicate && p.when ? ` (created ${p.when})` : ''}` : chosen.value;
  try {
    await api(`/api/search-profiles/${encodeURIComponent(chosen.value)}`, { method: 'DELETE' });
  } catch (err) {
    setRemoveError(err.message);
    return;
  }
  closeDialog($('dlgRemovePerson'));
  toast(`Removed ${name}. Nothing was erased; their files are kept on this computer.`, 'good');
  await afterChange();
}

/* ─────────────────────── add or edit a person ─────────────────────── */

const form = {
  mode: 'add', id: null, roles: [], resumeBase64: null, phone: '', rolesInitial: '[]',
};

const MAX_ROLES = 15;

/**
 * Is there anything typed here that Save has not stored? The boxes are judged
 * by the browser (value vs the value they were filled with); the job-title
 * chips are not boxes, so they are compared to how they started; and a resume
 * the person picked is data too.
 */
function personIsDirty() {
  return formIsDirty($('dlgPerson'))
    || JSON.stringify(form.roles) !== form.rolesInitial
    || form.resumeBase64 !== null;
}
guardDialog($('dlgPerson'), personIsDirty);
// Enter in a box must not save and close this dialog; Ctrl/Cmd+Enter does.
saveOnlyOnPurpose($('dlgPerson').querySelector('form'));

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

/**
 * @param {object} [values]
 * @param {{ pristine?: boolean }} [options] `pristine` (the default) says these values ARE
 *   the stored ones, so only later typing is an edit. Values read from a resume are
 *   not stored yet, so that caller passes false and they count as unsaved.
 */
function fillForm(values = {}, { pristine = true } = {}) {
  $('personName').value = displayName(values.fullName ?? '');
  $('personEmail').value = values.email ?? '';
  $('personCity').value = values.city ?? '';
  $('personState').value = values.state ?? '';
  $('personSeniority').value = values.seniority ?? '';
  $('personRemote').checked = values.remoteOnly === true;
  // Edit sends work modes only if this box is changed: it can express "remote
  // only" or "anything", and saving untouched would flatten a narrower stored
  // preference such as remote + hybrid into "anything".
  form.remoteInitial = $('personRemote').checked;
  form.roles = [];
  form.phone = values.phone ?? '';
  addRoles((values.targetRoles ?? []).join(','));
  for (const key of ['Name', 'Email', 'Roles', 'Form']) setFieldError(key, '');
  if (pristine) {
    markClean($('dlgPerson'));
    form.rolesInitial = JSON.stringify(form.roles);
  }
}

/** Open the form to add a person (optionally pre-filled from a resume already in hand). */
export async function openAddProfile({ file = null } = {}) {
  Object.assign(form, { mode: 'add', id: null, resumeBase64: null, allowDuplicate: false });
  $('dlgPersonTitle').textContent = 'Add a profile';
  $('dlgPersonSub').textContent = 'Each person gets their own jobs, resume and applications.';
  $('personSave').textContent = 'Add profile';
  $('personResumeRow').hidden = false;
  $('personActivateRow').hidden = false;
  $('personActivate').checked = true;
  $('personResumeStatus').textContent = 'Optional. A .docx file; it becomes their own master resume.';
  // The person's name feeds the seed label and the switch notice; on a cold
  // start the form can open before the profile list has arrived.
  if (!listingCache) await loadProfiles();
  // Offer a head start only when there is a list to start from.
  const { state } = await import('./state.js');
  const tracked = state.stats?.totals?.jobsTracked ?? 0;
  const owner = (document.body.dataset.person ?? '').split(' ')[0];
  $('personSeedRow').hidden = tracked === 0;
  $('personSeed').checked = tracked > 0;
  $('personSeedLabel').textContent = owner
    ? `Start with matching jobs from ${owner}'s list` : 'Start with matching jobs already found';
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
  $('personSeedRow').hidden = true;
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
    }, { pristine: false });
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
    seniority: $('personSeniority').value,
    ...(form.mode === 'add' || $('personRemote').checked !== form.remoteInitial ? { remoteOnly: $('personRemote').checked } : {}),
    ...(form.allowDuplicate ? { allowDuplicate: true } : {}),
  };
  for (const key of ['Name', 'Email', 'Roles', 'Form']) setFieldError(key, '');
  const before = listingCache?.activeId ?? null;
  try {
    const r = form.mode === 'add'
      ? await postJson('/api/search-profiles', {
        fields, activate: $('personActivate').checked, seed: !$('personSeedRow').hidden && $('personSeed').checked,
        ...(form.resumeBase64 ? { resume: { contentBase64: form.resumeBase64 } } : {}),
      })
      : await api(`/api/search-profiles/${encodeURIComponent(form.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
      });
    const { closeDialog } = await import('./dialogs.js');
    closeDialog($('dlgPerson'));
    const seededNote = seedNote(r.seeded);
    if (r.workspaceChanged) { reloadAsNewPerson(r.activated?.label ?? fields.fullName, before, seededNote); return; }
    toast(form.mode === 'add' ? `Added ${displayName(fields.fullName)}.${seededNote ? ` ${seededNote}` : ''}` : 'Saved.', 'good');
    if (r.active) scheduleRefresh(0);
    await afterChange();
  } catch (err) {
    const fieldErrors = err.body?.fields ?? null;
    const existing = err.body?.existing ?? null;
    if (existing) {
      // The same person already has a profile: offer it, or a deliberate copy.
      const node = $('personFormError');
      node.replaceChildren(
        el('span', { text: `${displayName(existing.name)} already has a profile. ` }),
        el('button', { type: 'button', class: 'small', 'data-action': 'person-use-existing', 'data-profile-id': existing.id, text: 'Switch to their profile' }),
        ' ',
        el('button', { type: 'button', class: 'small ghost', 'data-action': 'person-add-anyway', text: 'Add anyway' }),
      );
      node.hidden = false;
      node.querySelector('button')?.focus();
      return;
    }
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
    if (!input.value.trim()) return; // an empty Enter does nothing (see saveOnlyOnPurpose)
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

/** "Add anyway": the person asked for a second profile on purpose. */
export function addAnyway() {
  form.allowDuplicate = true;
  return savePerson();
}
