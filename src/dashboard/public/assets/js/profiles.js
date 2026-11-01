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
  return displayName(p?.name) || String(p?.label ?? p?.id ?? '').replace(/\s+[—-]\s+search$/i, '');
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
  const show = rows.length > 1;
  host.replaceChildren();
  $('profileMenuLabel').hidden = !show;
  $('profileMenuSep').hidden = !show;
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
  scheduleRefresh(0);
  await afterChange();
  announceSwitch(r.label, quiet ? null : before);
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
