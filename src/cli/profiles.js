/**
 * `npm run profiles` — create, inspect and switch search profiles.
 *
 * This is the command that makes the tool reusable without editing source. It
 * runs OUTSIDE the normal command path (like `doctor`) because it is a setup
 * tool: the config it edits may be the very thing that is wrong, so it must not
 * require a healthy config to start.
 *
 * Subcommands
 *   profiles                      list saved profiles, marking the active one
 *   profiles show [id]            everything one profile implies, in full
 *   profiles activate <id>        regenerate the runtime config from a profile
 *   profiles preview <id>         the same, computing but writing nothing
 *   profiles from-resume [--save] build a profile from the master resume
 *   profiles migrate              import an existing candidate.json as profile 1
 *   profiles refresh-background   re-read the active profile's background from the master resume
 *   profiles delete <id>
 */

import { relative } from 'node:path';
import { existsSync } from 'node:fs';

import { PROJECT_ROOT } from '../config/loadConfig.js';
import {
  listProfiles, readProfile, readActiveProfile, activateProfile, deleteProfile,
  migrateLegacyCandidate, saveProfile, proposeProfileFromResume, refreshBackgroundFromResume,
} from '../profile/store.js';
import { deriveFromProfile } from '../profile/derive.js';
import { loadRoleFamilies } from '../profile/roleFamilies.js';
import { masterResumeFile } from '../profile/workspace.js';

/** Where the master resume lives, relative to the root. */
/** The active person's master resume (each workspace has its own). */
const masterResume = (root) => masterResumeFile(root);

const out = (line = '') => process.stdout.write(`${line}\n`);

/**
 * @param {object} args
 * @param {{positionals: string[], flags: Set<string>, options: object}} args.parsed
 * @param {string} [args.root]
 * @returns {Promise<{command: string, ok: boolean, [k: string]: any}>}
 */
export async function runProfiles({ parsed, root = PROJECT_ROOT } = {}) {
  const [, sub, id] = parsed.positionals;
  const action = sub ?? 'list';

  switch (action) {
    case 'list': return listAction(root);
    case 'show': return showAction(root, id);
    case 'preview': return activateAction(root, id, { dryRun: true });
    case 'activate': return activateAction(root, id, { dryRun: false });
    case 'from-resume': return fromResumeAction(root, parsed);
    case 'migrate': return migrateAction(root);
    case 'refresh-background': return refreshBackgroundAction(root);
    case 'delete': return deleteAction(root, id);
    default:
      throw new Error(
        `unknown profiles subcommand "${action}". `
        + 'Use: list, show, preview, activate, from-resume, refresh-background, migrate, delete.',
      );
  }
}

function listAction(root) {
  const { profiles, activeId } = listProfiles(root);
  if (!profiles.length) {
    out('No search profiles yet.');
    out('');
    out('  npm run profiles migrate       import your existing config/candidate.json');
    out('  npm run profiles from-resume   build one from the active profile\'s master resume');
    return { command: 'profiles', ok: true, profiles: [] };
  }
  out(`${profiles.length} search profile(s):`);
  out('');
  for (const p of profiles) {
    const mark = p.active ? '*' : ' ';
    out(`${mark} ${p.id}`);
    out(`    ${p.label}`);
    if (p.error) {
      out(`    ! unreadable: ${p.error}`);
      continue;
    }
    out(`    targets  ${p.targetRoles.slice(0, 4).join(', ')}${p.targetRoles.length > 4 ? ` +${p.targetRoles.length - 4}` : ''}`);
    out(`    level    ${p.seniority || '(unspecified)'}   skills ${p.skillCount}   from ${p.source}`);
  }
  out('');
  out(activeId ? `Active: ${activeId}   (switch with: npm run profiles activate <id>)`
    : 'None active — the pipeline is running on config/candidate.json as written.');
  return { command: 'profiles', ok: true, profiles, activeId };
}

function showAction(root, id) {
  const profile = id ? readProfile(root, id) : readActiveProfile(root);
  if (!profile) throw new Error(id ? `no profile named "${id}"` : 'no profile is active — pass an id, or run `npm run profiles migrate`');
  const derived = deriveFromProfile(profile, { taxonomy: loadRoleFamilies(root) });

  out(`${profile.label}   (${profile.id})`);
  out('');
  // The two halves, labelled, because conflating them is the bug this whole
  // model exists to prevent.
  out('BACKGROUND — what the resume evidences');
  const b = profile.background;
  out(`  current roles   ${b.currentRoles.join(', ') || '(none)'}`);
  out(`  earlier roles   ${b.earlierRoles.slice(0, 4).join(', ') || '(none)'}`);
  out(`  experience      ${b.yearsExperience ? `${b.yearsExperience} years` : 'not stated'}`
    + `   level ${b.seniority ?? 'not stated'}`);
  out(`  industries      ${b.industries.join(', ') || '(none)'}`);
  out(`  skills          ${b.skills.length} term(s)`);
  out(`  leadership      ${b.leadership.hasManaged ? `yes — ${b.leadership.evidence.length} statement(s)` : 'no evidence'}`);
  out(`  source          ${b.source}${b.sourceFile ? ` (${b.sourceFile})` : ''}`);
  out('');
  out('SEARCH INTENT — what this person wants next');
  const i = profile.searchIntent;
  out(`  target roles    ${i.targetRoles.join(', ') || '(none)'}`);
  out(`  level           ${i.seniority || '(unspecified)'}`);
  out(`  work mode       ${i.workModes.join(', ') || '(any)'}`);
  out(`  locations       ${i.locations.join(', ') || '(any)'}   US-only gate ${i.usOnly ? 'on' : 'off'}`);
  out(`  employment      ${i.employmentTypes.join(', ') || '(any)'}`);
  out(`  industries      ${i.industries.join(', ') || '(any)'}`);
  out(`  compensation    ${i.compensation.display || (i.compensation.minAnnual ? `${i.compensation.minAnnual}+ ${i.compensation.currency}` : '(unstated)')}`);
  out(`  authorization   ${i.workAuthorization.status || '(unstated)'}${i.workAuthorization.requiresSponsorship ? ' — needs sponsorship' : ''}`);
  out(`  keep using      ${i.skillsToKeep.slice(0, 8).join(', ') || '(none)'}`);
  out(`  grow toward     ${i.skillsToGrow.join(', ') || '(none)'}`);
  out('');
  printDerived(derived);
  return { command: 'profiles', ok: true, profile, derived };
}

/** The part a user most needs to see: what this profile makes the agent DO. */
function printDerived(derived) {
  out('WHAT THIS MAKES THE AGENT DO');
  out(`  role families   ${derived.families.map((f) => f.label).join(', ') || '(none inferred)'}`);
  out(`  search queries  ${derived.searchPhrases.map((p) => `"${p}"`).join(', ') || '(none)'}`);
  out(`  recognizes      ${derived.candidate.targetTitles.length} title(s):`);
  for (const chunk of chunked(derived.candidate.targetTitles, 4)) out(`                    ${chunk.join(' · ')}`);
  out(`  scores on       ${derived.categories.map((c) => `${c.id} (${c.weight})`).join(', ')}`);
  out(`  gap vocabulary  ${derived.marketSkills.length} skill term(s) from your families`);
}

function chunked(list, size) {
  const out2 = [];
  for (let i = 0; i < list.length; i += size) out2.push(list.slice(i, i + size));
  return out2;
}

function activateAction(root, id, { dryRun }) {
  if (!id) throw new Error('usage: npm run profiles activate <id>   (list ids with `npm run profiles`)');
  const summary = activateProfile(root, id, { dryRun });
  out(dryRun ? `Preview of "${summary.label}" — nothing written.` : `Activated "${summary.label}".`);
  out('');
  out(`  role families   ${summary.families.map((f) => f.label).join(', ')}`);
  out(`  search queries  ${summary.searchPhrases.map((p) => `"${p}"`).join(', ')}`);
  out(`  recognizes      ${summary.targetTitles.length} title(s)`);
  out(`  excludes level  ${summary.seniorityExclusions.join(', ') || '(nothing — this profile targets the lowest level it searches)'}`);
  out('');
  if (dryRun) {
    out('Run without `preview` to write it.');
  } else {
    for (const file of summary.written) out(`  wrote ${file}`);
    out('');
    out('Every previous version was kept as .bak. Run `npm run score` to re-score the board against this profile.');
  }
  return { command: 'profiles', ok: true, ...summary };
}

async function fromResumeAction(root, parsed) {
  const resume = masterResume(root);
  const result = await proposeProfileFromResume(root, resume);
  if (!result.available) throw new Error(result.reason);

  const { comparison, proposal, preview, choices } = result;
  out(`Read ${relative(root, resume)}`);
  out('');
  out(`  ${comparison.summary}`);
  for (const reason of comparison.reasons) out(`    - ${reason}`);
  out('');
  out('PROPOSED SEARCH INTENT (nothing has been written)');
  out(`  target roles    ${proposal.searchIntent.targetRoles.join(', ') || '(none found)'}`);
  out(`  level           ${proposal.searchIntent.seniority || '(unspecified)'}`);
  out(`  role families   ${preview.families.map((f) => f.label).join(', ') || '(none inferred)'}`);
  out(`  search queries  ${preview.searchPhrases.map((p) => `"${p}"`).join(', ')}`);
  out(`  would recognize ${preview.targetTitles.length} title(s)`);
  out('');
  out('YOUR OPTIONS');
  for (const choice of choices) {
    out(`  ${choice.label}`);
    out(`    ${choice.detail}`);
  }
  out('');

  if (!parsed.flags.has('save')) {
    out('Nothing was written. To save this as a profile (still not active):');
    out('  npm run profiles from-resume -- --save');
    out('then activate it with `npm run profiles activate <id>`.');
    return { command: 'profiles', ok: true, saved: false, proposal, comparison };
  }

  const saved = saveProfile(root, proposal);
  out(`Saved profile "${saved.id}". It is NOT active yet — activate it with:`);
  out(`  npm run profiles activate ${saved.id}`);
  return { command: 'profiles', ok: true, saved: true, id: saved.id, proposal, comparison };
}

async function refreshBackgroundAction(root) {
  const result = await refreshBackgroundFromResume(root, masterResume(root));
  if (!result.ok) {
    out(`Not changed — ${result.reason}.`);
    return { command: 'profiles', ...result };
  }
  if (!result.changed.length) {
    out('Your profile background already matches the master resume. Nothing to change.');
    return { command: 'profiles', ...result };
  }
  out(`Updated "${result.id}" from the master resume: ${result.changed.join(', ')}.`);
  out('Your search goals (target roles, locations, pay, authorization) were not touched.');
  return { command: 'profiles', ...result };
}

function migrateAction(root) {
  const result = migrateLegacyCandidate(root);
  if (!result.migrated) {
    out(`Nothing to migrate — ${result.reason}.`);
    return { command: 'profiles', ok: true, ...result };
  }
  out(`Imported config/candidate.json as profile "${result.id}" (${result.label}), and made it active.`);
  out('');
  out('Your existing search is unchanged. From here you can:');
  out('  npm run profiles show            see exactly what it makes the agent do');
  out('  npm run profiles from-resume     build a second profile from a resume');
  out('  npm run profiles activate <id>   switch between them');
  return { command: 'profiles', ok: true, ...result };
}

function deleteAction(root, id) {
  if (!id) throw new Error('usage: npm run profiles delete <id>');
  const result = deleteProfile(root, id);
  out(`Deleted profile "${result.id}".`);
  return { command: 'profiles', ok: true, ...result };
}

/** True when a master resume exists — used by the first-run checklist. */
export function hasMasterResume(root = PROJECT_ROOT) {
  return existsSync(masterResume(root));
}
