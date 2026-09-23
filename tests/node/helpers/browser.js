/**
 * Browser-test availability, with a CI switch.
 *
 * Browser tests self-skip when Chromium cannot launch, so a laptop without
 * the download still gets a green run. In CI that same skip is a silent hole:
 * a broken `playwright install` step turned ~40 browser tests into "skipped"
 * and nobody noticed. With REQUIRE_BROWSER=1 a launch failure is rethrown, so
 * the suite fails instead.
 *
 * Usage, in a beforeAll:
 *   try { session = await createBrowserSession(...); }
 *   catch (err) { available = browserUnavailable(err); }
 *
 * @param {unknown} err the launch error
 * @returns {false} (so it can be assigned to `available`)
 */
export function browserUnavailable(err) {
  if (process.env.REQUIRE_BROWSER === '1') {
    throw new Error(`REQUIRE_BROWSER=1 but Chromium could not launch: ${err?.message ?? err}. `
      + 'Run `npx playwright install chromium`.');
  }
  return false;
}
