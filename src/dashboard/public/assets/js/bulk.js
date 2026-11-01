/** Which bulk steps a selection allows, and which one deserves the primary button. Pure: no DOM, no state. */

export const RUN_BUSY = 'A run is in progress — wait for it to finish';

/**
 * Why each bulk step cannot run for this selection, or null when it can.
 *
 * Only ever narrows what is offered. Every action still re-checks its own
 * conditions when it runs (batchAutofill re-reads the browser gate and the run
 * lock, then asks for confirmation), so a stale reason here can hide a button
 * but can never make one fire that should not.
 *
 * @param {number} n how many jobs are selected (some may not be loaded)
 * @param {object[]} jobs the selected jobs that ARE loaded
 * @param {{ running?: boolean, blocked?: string|null }} [gates]
 */
export function bulkStepReasons(n, jobs, { running = false, blocked = null } = {}) {
  const allKnown = jobs.length === n;
  // A packet exists once a resume was tailored or a packet prepared; the
  // approve route refuses jobs without one. Unknown (not yet loaded) rows
  // might have one, so Approve is only ruled out when every row is known.
  const hasPacket = jobs.some((j) => j.appStatus === 'needs_review' || j.appStatus === 'approved'
    || j.resumeStatus === 'prepared' || j.resumeStatus === 'tailored');
  return {
    prepare: running ? RUN_BUSY : null,
    approve: allKnown && !hasPacket ? 'None of the selected jobs has a prepared packet yet — prepare them first' : null,
    autofill: running ? RUN_BUSY : blocked,
    compare: n < 2 ? 'Select 2 to 4 jobs to compare' : null,
  };
}

/**
 * The one pipeline step worth the primary button, from where the selected
 * jobs actually are: packets waiting for you → Approve; approved → Auto-fill;
 * otherwise → Prepare. Auto-fill is never promoted while it is unavailable.
 *
 * @param {object[]} jobs
 * @param {ReturnType<typeof bulkStepReasons>} reasons
 * @returns {'prepare'|'approve'|'autofill'}
 */
export function primaryBulkStep(jobs, reasons) {
  if (jobs.some((j) => j.appStatus === 'needs_review')) return 'approve';
  if (!reasons.autofill && jobs.some((j) => j.appStatus === 'approved')) return 'autofill';
  return 'prepare';
}
