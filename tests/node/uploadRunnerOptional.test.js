import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { uploadFiles } from '../../src/automation/uploadRunner.js';

const FILE = join(process.cwd(), 'tests', 'node', 'fixtures', 'sample_resume.txt');

describe('optional application uploads', () => {
  const page = { locator: () => ({ count: async () => 0 }) };

  it('skips an unavailable optional cover letter without blocking the application', async () => {
    const result = await uploadFiles(page, { uploads: [
      { type: 'coverLetter', path: FILE, selector: null, required: false },
    ] });
    expect(result.blockers).toEqual([]);
    expect(result.skipped[0].reason).toContain('no upload selector');
  });

  it('still blocks when the required resume input is unavailable', async () => {
    const result = await uploadFiles(page, { uploads: [
      { type: 'resume', path: FILE, selector: '#resume', required: true },
    ] });
    expect(result.blockers[0]).toContain('upload input not found');
  });
});
