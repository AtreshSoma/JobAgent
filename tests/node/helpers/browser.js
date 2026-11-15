import { beforeEach } from 'vitest';

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

/**
 * Run a launch, or return null when Chromium is unavailable (rethrown under
 * REQUIRE_BROWSER=1, as above). Pair with `skipWithoutBrowser` in the same
 * describe so its tests skip instead of failing on a null browser.
 *
 *   beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch()); });
 *   skipWithoutBrowser(() => browser);
 *
 * @template T
 * @param {() => Promise<T>} launch
 * @returns {Promise<T|null>}
 */
export async function launchOrSkip(launch) {
  try {
    return await launch();
  } catch (err) {
    browserUnavailable(err);
    return null;
  }
}

/**
 * Skip each test in the enclosing describe (or file) while `get()` is falsy.
 *
 * @param {() => unknown} get returns the launched browser, or null
 */
export function skipWithoutBrowser(get) {
  beforeEach((ctx) => {
    if (!get()) ctx.skip();
  });
}
