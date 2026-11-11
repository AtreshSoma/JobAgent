import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';

import { isInsideDirectory, assertInsideDirectory } from '../../src/utils/pathSafe.js';

const win = process.platform === 'win32';
const root = win ? 'c:\\ws' : '/ws';
const p = (...parts) => [root, ...parts].join(sep);

describe('isInsideDirectory', () => {
  it('accepts the directory itself', () => {
    expect(isInsideDirectory(root, root)).toBe(true);
  });

  it('accepts nested files', () => {
    expect(isInsideDirectory(root, p('applications', 'output', 'r.pdf'))).toBe(true);
  });

  it('rejects a sibling that merely shares a name prefix', () => {
    // The classic startsWith() bug: "/ws-evil" begins with "/ws".
    const sibling = win ? 'c:\\ws-evil\\x' : '/ws-evil/x';
    expect(isInsideDirectory(root, sibling)).toBe(false);
  });

  it('rejects parent traversal', () => {
    expect(isInsideDirectory(root, p('..', 'secret.txt'))).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isInsideDirectory(root, win ? 'c:\\other\\x' : '/other/x')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isInsideDirectory('', root)).toBe(false);
    expect(isInsideDirectory(root, '')).toBe(false);
  });

  it.runIf(win)('ignores drive-letter case on Windows', () => {
    // realpathSync preserves whatever case it was given, so the workspace and a
    // stored artifact path routinely disagree on the drive letter. Treating that
    // as an escape made every resume download 403.
    expect(isInsideDirectory('c:\\ws', 'C:\\ws\\a\\b.pdf')).toBe(true);
    expect(isInsideDirectory('C:\\ws', 'c:\\ws\\a\\b.pdf')).toBe(true);
    expect(isInsideDirectory('c:\\ws', 'C:\\WS\\A\\b.pdf')).toBe(true);
  });

  it.runIf(win)('still rejects a different drive', () => {
    expect(isInsideDirectory('c:\\ws', 'd:\\ws\\a')).toBe(false);
  });

  it.runIf(!win)('stays case-sensitive on case-sensitive filesystems', () => {
    expect(isInsideDirectory('/ws', '/WS/a')).toBe(false);
  });
});

describe('assertInsideDirectory', () => {
  it('returns the path when contained', () => {
    const target = p('a.pdf');
    expect(assertInsideDirectory(root, target)).toBe(target);
  });

  it('throws a 403-shaped error when not contained', () => {
    try {
      assertInsideDirectory(root, win ? 'c:\\other\\x' : '/other/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(403);
      expect(err.message).toMatch(/escapes the Job Agent workspace/);
    }
  });
});
