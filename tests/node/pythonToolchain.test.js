/**
 * Python lint runs on a fresh setup, at the same ruff CI uses (audit N7).
 *
 * `npm run lint` runs ruff only when it is installed, and ruff was in no
 * requirements file: CI installed whatever ruff was newest, and a local setup
 * never linted Python at all, without saying so. ruff is now pinned in
 * requirements.txt, which both CI and `pip install -r requirements.txt` use.
 * The license review lists every pinned package at its pinned version.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pins = Object.fromEntries(read('requirements.txt').split('\n')
  .map((line) => line.replace(/#.*/, '').trim())
  .filter(Boolean)
  .map((line) => line.split('=='))
  .filter((parts) => parts.length === 2));

describe('Python toolchain', () => {
  it('pins ruff in requirements.txt', () => {
    expect(pins.ruff).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('CI lints with the pinned ruff, not whatever is newest', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/pip install ruff\b/);
    const lintJob = ci.slice(ci.indexOf('\n  lint:'));
    expect(lintJob).toMatch(/pip install -r requirements\.txt/);
  });

  it('npm run lint finds Python the way the app does (the project .venv first)', () => {
    const lint = read('scripts/lint.mjs');
    expect(lint).toMatch(/import \{ pythonExe \} from '..\/src\/resume\/pythonEnv\.js';/);
    expect(lint).toMatch(/pip install -r requirements\.txt/);
  });

  it('the license review lists every pinned package at its pinned version', () => {
    const review = read('docs/LICENSE_REVIEW.md');
    for (const [name, version] of Object.entries(pins)) {
      expect(review, `${name} ${version} in docs/LICENSE_REVIEW.md`).toMatch(new RegExp(`\\| ${name} \\| ${version.replace(/\./g, '\\.')} \\|`));
    }
  });
});
