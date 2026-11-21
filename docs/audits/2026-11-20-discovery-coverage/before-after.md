# Discovery coverage: before vs after (2026-11-20)

Companion to [`../2026-11-20-discovery-coverage.md`](../2026-11-20-discovery-coverage.md). "Before" is the store and
config as they stood after the last run on the old code (2026-11-21 02:29 UTC, `LAST_7_DAYS`). "After" is the same
store once `npm run rejudge-stale -- --apply` had run, plus the new config and code. **No discovery run has used the
new code yet**, so per-employer job counts for newly added employers are still zero; they fill in on the next
*Find new jobs*. Re-measure with `npm run coverage:audit`.

## 1. Employers

| | Before | After |
| --- | --- | --- |
| Board/tenant/site entries across all sources | 691 | **721** (+19 Workday, +8 careers sites, +1 Ashby, +1 Oracle, +1 iCIMS) |
| Major employers with an automated route that were **not configured** | 29 (zero rows ever) | **0** (a test now fails if one goes missing) |
| Major employers with no automated route | not recorded | 11, each with its reason |

Added, verified live today with one request each (job counts follow the next search):

| Route | Employers |
| --- | --- |
| Careers-site job sitemap | Microsoft, Apple, Netflix, Qualcomm, UnitedHealth Group, Comcast, Kaiser Permanente, John Deere |
| Workday | Cisco, HP Inc., Broadcom, Boeing, Disney, Fidelity, Cigna, Elevance Health, Vanguard, The Home Depot, Lowe's, Nike, Micron, Applied Materials, KLA, Analog Devices, eBay, 3M, Morgan Stanley |
| Ashby | Snowflake |
| Oracle Recruiting (employer domain) | Dell Technologies |
| iCIMS | Charles Schwab |

Sample of what the new code returned live (8 pages per employer, your profile):

- **Microsoft**: Principal Data Engineering Architect (Redmond), Senior Data Engineer (Redmond), Cloud Solutions Architect – Azure Data & AI
- **Apple**: Senior Data Engineer, Sr. Data Engineer – Services Special Projects, Data Engineer – Operations Finance, Health Research Data Engineer, Sr Engineering Manager – Finance Data Engineering
- **UnitedHealth Group**: Senior Data Engineer (×3), Principal Data Engineer – Remote, Senior Cloud Data Engineer – Remote

Still not reachable automatically (add their postings by URL):

| Employer | Why |
| --- | --- |
| Google | robots.txt disallows every job page |
| Tesla | 403 |
| IBM | Empty HTTP 202 for every page |
| Goldman Sachs, Uber, American Express | No public listing found |
| Lam Research, Expedia | No board or job sitemap found |
| LinkedIn, Cognizant | URL reader by design / WAF blocks the identifying client |
| Starbucks | Reachable, deliberately left out (almost all retail) |

## 2. Discovery behaviour

| | Before | After |
| --- | --- | --- |
| Job first seen after the window | Written as `stale`, never judged again | Judged if posted since the source was last read **in full** (per source, per profile) |
| Measured loss | Nov 16 (3-day window): 56,330 of 60,532 found jobs dropped as stale. Nov 21 (7-day window): 65,682 of 83,520 found jobs. | Bounded by the gap since each source's last complete read; nothing lost to a missed day or failed source |
| Newly added employer | Only roles posted in the last 3–7 days | Open roles matching your titles, up to 45 days old, once |
| Careers sitemaps | First 50 URLs in file order (Meta: 125 rows, 0 kept) | Filtered by title and US location before fetching, best fit first, 150 new pages per employer per run, judged pages not re-read (Microsoft: 2,446 URLs → 27 worth reading) |
| Undated careers-site jobs | Always dropped (Capgemini, EY, KPMG, Wipro: 353 rows, 100% dropped) | Dated by first appearance in the sitemap after its first read |
| Workday "Posted 30+ Days Ago" | Stored as exactly 30 days | Lower bound: shown as "30+", never admitted through a wider window |
| Employer returning nothing | Invisible ("ok") | Listed in *Discovery and data quality* after each full search |

## 3. Your store (postings whose title is one you stated or an adjacent one)

| Outcome | Before | After rejudge |
| --- | --- | --- |
| Total | 2,030 | 2,030 |
| Discarded as stale | **1,652** | **812** (the rest are past the 45-day retention limit) |
| Waiting to be judged | 24 | **464** (444 re-admitted) |
| Discarded by a rule, with the real reason | 194 | 590 (396 relabelled, mostly non-US: 515 geography in total) |
| Low score | 18 | 22 |
| Active on the board | 139 | 139 (re-admitted rows are judged on the next search or description pass) |

Examples re-admitted: Walmart "Principal, Data Engineer", "Staff, Data Engineer", "Senior, Data Engineer";
Capital One "Data Engineer 4" (×3); Amazon "Data Engineer II"; Chime "Director, Data Engineering";
Booz Allen "Enterprise Data Architect".

## 4. Bugs fixed

| Bug | Effect before | After |
| --- | --- | --- |
| Uncaught stream error in the shared web-request code on any redirect with a body | Could crash the whole agent process (reproduced on Dell's and Lam Research's careers sites) | Redirect bodies drained; regression test |
| Careers-page job ids built from the page title | Every Wipro posting overwrote the last; same-title Costco postings merged | Id uses the posting number in the URL; title suffixes stripped |
| Platform registry notes | Said Microsoft/Eightfold and TalentBrew could not be enumerated | Corrected, with the sitemap route; Oracle on employer domains detected |

## 5. Done today

- `npm run rejudge-stale -- --apply` on the active profile (444 re-admitted, 396 relabelled; a second run finds nothing).
- Dashboard restarted on the new code (port 4646); *Discovery and data quality* shows the new rules.
- In-app changelog has a 2026-11-20 entry (unversioned; the version stays v0.2.3 until you release), and
  `CHANGELOG.md` was regenerated from it.

## 6. Next step

Click **Find new jobs**. The first search on the new code takes longer than usual: no source has a complete read on
record yet, so each one gets the one-time backfill of title-matching roles. Then run `npm run coverage:audit` to see
the per-employer "after" counts.
