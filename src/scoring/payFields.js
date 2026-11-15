/**
 * The stated pay range of a posting, as stored fields (audit D6).
 *
 * Salary was a preference, not a field: constraints read what a posting says,
 * but nothing kept it, so the list could not be sorted or filtered by pay. This
 * turns what `postedPay` reads (compensation field first, then a strict read of
 * the description) into columns: annual figures, the period it was stated in,
 * the currency, and where it was read. A posting that states no pay is
 * `null`, which every consumer shows as "Not stated"; never zero, never low.
 *
 * Only US dollars are read today (see searchConstraints.js), so the currency
 * is USD whenever a range is stored.
 */
import { postedPay } from './searchConstraints.js';

const PER_HOUR = /\b(per\s+hour|hourly|an\s+hour|\/\s*hr|\/\s*hour|p\/h)\b/i;
const PER_MONTH = /\b(per\s+month|monthly|a\s+month|\/\s*month|\/\s*mo)\b/i;

/**
 * @param {object} job normalized job or a jobs-table row
 * @returns {{pay_min: number|null, pay_max: number|null, pay_period: string|null, pay_currency: string|null,
 *   pay_source: string|null, pay_checked: 1}}
 */
export function payFields(job = {}) {
  const pay = postedPay(job);
  if (!pay) return { pay_min: null, pay_max: null, pay_period: null, pay_currency: null, pay_source: null, pay_checked: 1 };
  const text = String(pay.text ?? '');
  return {
    pay_min: Math.round(pay.min),
    pay_max: Math.round(pay.max),
    pay_period: PER_HOUR.test(text) ? 'hour' : (PER_MONTH.test(text) ? 'month' : 'year'),
    pay_currency: 'USD',
    pay_source: pay.source,
    pay_checked: 1,
  };
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * One plain sentence for a row's stored pay, or "Not stated".
 * @param {object} row jobs-table row (pay_* columns)
 */
export function payLabel(row = {}) {
  if (row.pay_min == null || row.pay_max == null) return 'Not stated';
  const range = row.pay_min === row.pay_max ? `${money(row.pay_min)} a year` : `${money(row.pay_min)} to ${money(row.pay_max)} a year`;
  const stated = row.pay_period === 'hour' ? ', stated hourly' : (row.pay_period === 'month' ? ', stated monthly' : '');
  const from = row.pay_source === 'description' ? 'posting text' : 'compensation field';
  return `${range}${stated} (${from})`;
}
