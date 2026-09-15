/**
 * Backfill employment_category for jobs already stored in the database.
 *
 * The employment-type classifier (Full-time vs Contract) runs automatically on
 * every new discovery/score. This one-off maintenance script applies the same
 * deterministic, config-driven classification to jobs that were stored BEFORE
 * the feature existed (their employment_category is NULL), so the dashboard's
 * Type column and filter are populated on your existing data too.
 *
 * Safe + reversible: it only sets a derived column from each job's already
 * stored title / JD / employment_type. It never fabricates or fetches anything.
 *
 * Usage:  node scripts/backfillEmployment.mjs [--all]
 *   (default) classify only rows missing a category
 *   --all     re-classify every row (use after tuning config/exclusions.json)
 */

import { loadConfig } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';
import { classifyEmployment } from '../src/scoring/employmentClassifier.js';

function main() {
  const all = process.argv.includes('--all');
  const config = loadConfig();
  const markers = config.exclusions?.employmentTypes ?? {};
  const db = openDatabase();

  const jobs = db.listJobs();
  let updated = 0;
  const tally = {};
  for (const row of jobs) {
    if (!all && row.employment_category) continue;
    const { category } = classifyEmployment(
      { employmentType: row.employment_type, title: row.title, jdText: row.jd_text },
      markers,
    );
    db.upsertJob({ id: row.id, employment_category: category });
    tally[category] = (tally[category] ?? 0) + 1;
    updated += 1;
  }

  db.close();
  console.log(`Backfilled employment_category for ${updated} job(s) of ${jobs.length} total.`);
  console.log('Breakdown:', JSON.stringify(tally, null, 2));
}

main();
