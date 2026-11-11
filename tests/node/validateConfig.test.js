import { describe, it, expect } from 'vitest';
import {
  createValidator,
  validateConfig,
  assertValidConfig,
  formatErrors,
} from '../../src/config/validateConfig.js';

const exclusionsSchema = {
  type: 'object',
  required: ['sponsorshipDenial'],
  properties: {
    sponsorshipDenial: { type: 'array', items: { type: 'string' } },
  },
};

describe('validateConfig', () => {
  it('passes valid data', () => {
    const result = validateConfig('exclusions', { sponsorshipDenial: ['no sponsorship'] }, exclusionsSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeNull();
  });

  it('fails and produces a readable message for invalid data', () => {
    const result = validateConfig('exclusions', { sponsorshipDenial: 'oops' }, exclusionsSchema);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/Invalid exclusions config/);
  });

  it('assertValidConfig throws on invalid data', () => {
    expect(() => assertValidConfig('exclusions', {}, exclusionsSchema)).toThrow(/Invalid exclusions config/);
  });

  it('reuses a shared ajv instance', () => {
    const ajv = createValidator();
    expect(validateConfig('exclusions', { sponsorshipDenial: [] }, exclusionsSchema, { ajv }).valid).toBe(true);
  });

  it('formatErrors handles empty errors gracefully', () => {
    expect(formatErrors('x', [])).toMatch(/Invalid x config/);
  });
});
