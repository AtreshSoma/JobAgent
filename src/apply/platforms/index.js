/**
 * Platform registry. Maps an ATS platform key to its form-prep descriptor and
 * resolves the right adapter for a detected platform (falling back to generic).
 */

import { descriptor as greenhouse } from './greenhouse.js';
import { descriptor as lever } from './lever.js';
import { descriptor as ashby } from './ashby.js';
import { descriptor as workday } from './workday.js';
import { descriptor as icims } from './icims.js';
import { descriptor as taleo } from './taleo.js';
import { descriptor as smartrecruiters } from './smartrecruiters.js';
import { descriptor as jobvite } from './jobvite.js';
import { descriptor as generic } from './generic.js';

export const PLATFORMS = Object.freeze({
  greenhouse, lever, ashby, workday, icims, taleo, smartrecruiters, jobvite, generic,
});

/**
 * @param {string} platformKey detected platform key
 * @returns {object} platform descriptor (generic if unknown)
 */
export function getPlatform(platformKey) {
  return PLATFORMS[platformKey] ?? generic;
}
