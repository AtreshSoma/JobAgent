/**
 * Shared factory for ATS platform form-prep adapters.
 *
 * Each platform exports a descriptor created here. A descriptor knows the
 * platform's common field selectors and produces a deterministic fill PLAN for a
 * given application packet. Critically, every plan sets `submitReady: false` and
 * carries `stopBeforeSubmit: true` — these adapters prepare forms but NEVER click
 * the final submit button. Final submission requires explicit human approval in a
 * later step.
 */

/**
 * @param {object} spec
 * @param {string} spec.key platform key
 * @param {string} spec.name human-readable name
 * @param {Record<string,string>} spec.selectors canonical field -> CSS selector
 * @param {object} [spec.fileInputs] { resume, coverLetter } CSS selectors
 * @param {string} [spec.submitSelector] selector of the final submit button (for reference only)
 * @returns {object} platform descriptor
 */
export function makePlatform({ key, name, selectors = {}, fileInputs = {}, submitSelector = null }) {
  return {
    key,
    name,
    selectors,
    fileInputs,
    submitSelector,
    /**
     * Build a fill plan by binding prefill entries to this platform's selectors.
     * @param {object} packet application packet (see applicationPacket.js)
     * @returns {object} fill plan
     */
    prepare(packet = {}) {
      const prefill = packet.prefill?.plan ?? [];
      const steps = prefill.map((entry) => ({
        field: entry.field,
        label: entry.label,
        value: entry.value,
        source: entry.source,
        selector: entry.selector || selectors[entry.field] || null,
        resolved: Boolean(entry.selector || selectors[entry.field]),
      }));

      const uploads = (packet.uploads?.uploads ?? []).map((u) => ({
        type: u.type,
        path: u.path,
        selector: fileInputs[u.type] ?? null,
        resolved: Boolean(fileInputs[u.type]),
        // A resume is required for the assisted application flow. A generated
        // cover letter is an optional enhancement: many ATSes (including most
        // Workday configurations) do not expose a cover-letter input at all.
        required: u.type === 'resume',
      }));

      const needsUser = packet.prefill?.needsUser ?? [];

      return {
        platform: key,
        steps,
        uploads,
        needsUser,
        submitSelector,
        // HARD STOP: adapters never auto-submit.
        stopBeforeSubmit: true,
        submitReady: false,
      };
    },
  };
}
