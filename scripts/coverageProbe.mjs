#!/usr/bin/env node
/**
 * Probe the saved ATS form fixtures and record auto-fill coverage (audit A1).
 *
 *   node scripts/coverageProbe.mjs            # probe the fixtures, record into this workspace
 *   node scripts/coverageProbe.mjs --dry      # print, record nothing
 *
 * SAVED PAGES ONLY. Every form here is a file under tests/node/fixtures/ats/,
 * served to a local browser by route; any other request is aborted, and
 * probeForm refuses a non-local URL. A probe of a real employer's site is not
 * possible with this script and needs the owner's go-ahead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { loadConfig, PROJECT_ROOT } from '../src/config/loadConfig.js';
import { coverageTable, probeForm, recordCoverage } from '../src/automation/coverageProbe.js';

const FIXTURES = [
  { ats: 'icims', file: 'icims_step1.html', url: 'https://careers-acme.icims.example.test/jobs/1/apply' },
  { ats: 'taleo', file: 'taleo_step1.html', url: 'https://acme.taleo.example.test/careersection/2/jobapply.ftl' },
  { ats: 'jobvite', file: 'jobvite_form.html', url: 'https://jobs.jobvite.example.test/acme/apply' },
];
const dry = process.argv.includes('--dry');
const config = loadConfig({ loadEnv: false });
const browser = await chromium.launch({ headless: true });
const records = [];
try {
  for (const fx of FIXTURES) {
    const html = readFileSync(join(PROJECT_ROOT, 'tests', 'node', 'fixtures', 'ats', fx.file), 'utf8');
    const context = await browser.newContext();
    await context.route('**/*', (route) => (new URL(route.request().url()).hostname === new URL(fx.url).hostname
      ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
      : route.abort()));
    const page = await context.newPage();
    const record = await probeForm({ page, url: fx.url, config, ats: fx.ats });
    records.push(record);
    if (!dry) recordCoverage(config.root ?? PROJECT_ROOT, record);
    console.log(`${fx.ats.padEnd(8)} found ${record.found}, would fill ${record.mapped}, need you ${record.needsYou}, uploads ${record.uploads}`);
    await context.close();
  }
} finally {
  await browser.close();
}
const table = coverageTable(records);
console.log(`\n${table.basis}${dry ? ' (nothing recorded: --dry)' : ''}`);
