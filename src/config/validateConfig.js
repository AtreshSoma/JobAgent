/**
 * Config validation using ajv against the JSON schemas in config/schemas.
 *
 * Fails loudly with a readable, aggregated error message listing every schema
 * violation. This is invoked at startup so invalid config never reaches the
 * pipeline.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/** Logical config name -> schema filename under config/schemas. */
export const SCHEMA_FILES = {
  candidate: 'candidate.schema.json',
  scoring: 'scoring.schema.json',
  exclusions: 'exclusions.schema.json',
  jobboards: 'jobboards.schema.json',
  coverLetter: 'cover_letter.schema.json',
};

/**
 * Create a configured Ajv instance.
 * @returns {import('ajv').default}
 */
export function createValidator() {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Format ajv errors into a single human-readable string.
 * @param {string} name config name
 * @param {import('ajv').ErrorObject[]|null|undefined} errors
 * @returns {string}
 */
export function formatErrors(name, errors) {
  if (!errors || errors.length === 0) return `Invalid ${name} config.`;
  const lines = errors.map((e) => {
    const path = e.instancePath || '(root)';
    return `  - ${path} ${e.message}` + (e.params ? ` ${JSON.stringify(e.params)}` : '');
  });
  return `Invalid ${name} config:\n${lines.join('\n')}`;
}

/**
 * Validate a single config object against its schema.
 *
 * @param {string} name one of SCHEMA_FILES keys
 * @param {unknown} data parsed config object
 * @param {object} schema parsed JSON schema object
 * @param {object} [options]
 * @param {import('ajv').default} [options.ajv] reuse an Ajv instance
 * @returns {{valid: boolean, errors: import('ajv').ErrorObject[]|null, message: string|null}}
 */
export function validateConfig(name, data, schema, { ajv = createValidator() } = {}) {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return {
    valid,
    errors: valid ? null : validate.errors ?? [],
    message: valid ? null : formatErrors(name, validate.errors),
  };
}

/**
 * Validate and throw on failure.
 * @param {string} name
 * @param {unknown} data
 * @param {object} schema
 * @param {object} [options]
 * @returns {true}
 */
export function assertValidConfig(name, data, schema, options) {
  const result = validateConfig(name, data, schema, options);
  if (!result.valid) {
    throw new Error(result.message);
  }
  return true;
}
