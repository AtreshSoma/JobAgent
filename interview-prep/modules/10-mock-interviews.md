# Module 10 — Full Mock Interviews (Timed, With Model Answers)

**How to use:** Set a timer. **Cover the answers.** Speak (or write) your response out loud as if a
human is listening, *then* compare. Record yourself for the behavioral ones. Each mock simulates a real
loop drawn from the company archetypes in your applications.

- **Mock 1 — Fintech / high-growth** (Robinhood / SoFi / Instacart / Brex style)
- **Mock 2 — Big Tech** (Amazon / Microsoft / Dropbox style)
- **Mock 3 — Platform vendor** (Databricks / MongoDB style — deep internals)
- **Mock 4 — Consulting / Azure shop** (Accenture / Capgemini / Quisitive style)

---

## MOCK 1 — Fintech Senior Data/Analytics Engineer (60 min)

### Round 1.1 — SQL (15 min)
**Q:** `transactions(user_id, txn_ts, amount, status)`. For each user, find their **first** successful
transaction and the **days until** their second successful transaction.
<details><summary>Model answer</summary>

```sql
WITH succ AS (
  SELECT user_id, txn_ts,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY txn_ts) AS rn
  FROM transactions
  WHERE status = 'success'
),
p AS (
  SELECT user_id,
         MAX(CASE WHEN rn = 1 THEN txn_ts END) AS first_ts,
         MAX(CASE WHEN rn = 2 THEN txn_ts END) AS second_ts
  FROM succ
  WHERE rn <= 2
  GROUP BY user_id
)
SELECT user_id, first_ts, second_ts,
       DATEDIFF(day, first_ts, second_ts) AS days_to_second
FROM p
WHERE second_ts IS NOT NULL;
```
Talk track: filter to success first, rank, pivot the first two with conditional aggregation, then diff.
Mention users with only one success return NULL (filtered out, or kept with a LEFT pattern if needed).
</details>

### Round 1.2 — Analytics Engineering / dbt (10 min)
**Q:** "How would you build a trustworthy daily revenue metric used by 5 teams?"
<details><summary>Model answer</summary>

Define it **once** in a semantic/metric layer (dbt metric or Power BI measure) over a conformed
`fct_revenue` at a declared grain. In dbt: a `staging` model per source, an `intermediate` join/clean
layer, a `marts/fct_revenue` incremental model (`unique_key`), plus **tests** (`not_null`, `unique`,
`relationships`) and a **source freshness** check. CI runs `dbt build` on PRs. Now every team `ref`s the
same model — no divergent definitions. (Tie to your 25-SSAS→Fabric semantic-layer consolidation.)
</details>

### Round 1.3 — Pipeline design (20 min)
**Q:** "Design a pipeline to ingest payment events and power both a real-time fraud check and daily
finance reporting."
<details><summary>Model answer</summary>

This is a **Lambda/lakehouse** problem. Stream payment events into **Kafka**; **Structured Streaming**
scores fraud in real time with event-time windows + watermark for velocity features, writing alerts to
a low-latency store and raw events to **Delta Bronze** (checkpointed, exactly-once). A **batch** Silver/
Gold job builds the finance star schema daily via MERGE (idempotent), reconciling any late data. Same
Delta tables serve BI (Power BI/warehouse). Cross-cutting: idempotency, schema evolution, dbt/DLT tests,
freshness SLAs, PII masking (it's payments — compliance matters), monitoring consumer lag. Trade-off:
streaming only where seconds matter (fraud); batch for reporting to keep it simple and cheap.
</details>

### Round 1.4 — Behavioral (15 min)
**Q:** "Tell me about a time you improved data trust." → **Story F** (68%→94%). 90 seconds, STAR,
quantified. Follow-up "how did you measure confidence?" → stakeholder survey + reduced data-dispute
tickets + freshness/quality scorecards.

---

## MOCK 2 — Big Tech Senior Data Engineer (75 min)

### Round 2.1 — Python/PySpark coding (20 min)
**Q:** Given a DataFrame of `(user_id, page, event_ts)`, compute each user's **session count** where a
new session starts after 30 minutes of inactivity.
<details><summary>Model answer</summary>

```python
from pyspark.sql import functions as F, Window
w = Window.partitionBy("user_id").orderBy("event_ts")

sessions = (events
  .withColumn("prev_ts", F.lag("event_ts").over(w))
  .withColumn("new_session",
      F.when(F.col("prev_ts").isNull() |
             (F.col("event_ts").cast("long") - F.col("prev_ts").cast("long") > 30*60), 1)
       .otherwise(0))
  .withColumn("session_id", F.sum("new_session").over(w))
  .groupBy("user_id").agg(F.max("session_id").alias("session_count")))
```
Talk track: this is the **sessionization** pattern (Module 01 P5) in PySpark — `lag` for the gap, a
running `sum` of session-start flags assigns session ids, then aggregate. Note window functions cause a
shuffle; partition by `user_id`. Mention skew if a few power users dominate → still fine since each
user's data fits a partition, but a single mega-user could be a hot key.
</details>

### Round 2.2 — Data modeling (15 min)
**Q:** "Model a ride-sharing trips warehouse for analytics."
<details><summary>Model answer</summary>

Grain = **one row per completed trip**. `fct_trip`: FKs `date_key`, `rider_key`, `driver_key`,
`pickup_loc_key`, `dropoff_loc_key`, `vehicle_key`, `promo_key`; degenerate `trip_id`; measures
`distance`, `duration_sec`, `fare`, `tip`, `surge_multiplier` (non-additive — keep components),
`driver_payout`. Dims: `dim_rider`/`dim_driver` (SCD2 for rating/tier history), `dim_location`,
`dim_date` (role-playing pickup/dropoff), `dim_vehicle`. For lifecycle (requested→matched→completed),
an **accumulating snapshot** with milestone date FKs and lag measures. Call out additive vs non-additive
(surge), and conformed `dim_date`/`dim_location` reused across trips, payments, incidents facts.
</details>

### Round 2.3 — System design (25 min)
**Q:** "Design the analytics data platform for a product with 100M daily events."
<details><summary>Model answer</summary>

Use the Module 08 framework. Clarify consumers/freshness/scale (100M/day ≈ ~1.2K eps avg, peak higher;
sized storage ≈ events × bytes). Ingest: clickstream via Kafka/Event Hub → Structured Streaming →
**Delta Bronze**; OLTP via **CDC**; APIs via batch. Medallion transform in Spark/dbt to conformed Gold
stars. Serve BI via semantic models, DS via feature tables, low-latency metrics via an OLAP store.
Orchestrate with Airflow/Workflows. Then **spend half the time on cross-cutting**: idempotency (MERGE +
checkpoints), schema evolution, DQ expectations + quarantine, partitioning by date + OPTIMIZE/Z-ORDER,
skew handling (salting/AQE), backfills via replay, observability (lineage, freshness, consumer lag),
cost (job clusters, auto-suspend, scanned-data reduction), governance (Unity Catalog, PII). Close with
trade-offs and v2 improvements (e.g., move from Lambda to unified Delta streaming).
</details>

### Round 2.4 — Behavioral / LP deep dive (15 min)
**Q (Dive Deep):** "Tell me about the hardest bug/perf issue you debugged." → Module 03 **D2** (4× slow
Silver job). Expect 4 levels of "why?": be ready with the exact Spark UI signals (task skew, shuffle
size, spill), the root cause (hot key / small files / lost broadcast), and the fix (salt / OPTIMIZE /
re-broadcast). **Know your numbers.**

---

## MOCK 3 — Data Platform Vendor (Databricks / MongoDB) (60 min)

### Round 3.1 — Spark internals rapid-fire (15 min)
<details><summary>Q&A</summary>

- **"Job → stage → task — what defines a stage boundary?"** A shuffle (wide dependency).
- **"Default join for two big tables?"** Sort-merge; broadcast if one side is small.
- **"How does AQE help?"** Runtime re-optimization: coalesce shuffle partitions, switch to broadcast,
  split skewed partitions.
- **"What causes an OOM on the driver?"** `collect()`/`toPandas()` of large data; huge broadcast.
- **"narrow vs wide?"** narrow = 1 input→1 output partition (no shuffle); wide = many→one (shuffle).
- **"How do you fix skew?"** Salting, AQE skew join, broadcast small side, isolate hot keys.
</details>

### Round 3.2 — Delta deep dive (15 min)
<details><summary>Q&A</summary>

- **"How does Delta give ACID?"** Transaction log (`_delta_log`) of add/remove file actions + optimistic
  concurrency; readers see a consistent snapshot.
- **"OPTIMIZE vs Z-ORDER?"** Compaction vs multi-dimensional clustering for data skipping.
- **"VACUUM danger?"** Deletes unreferenced files past retention; too-low retention breaks time travel &
  concurrent readers.
- **"How does MERGE help CDC?"** Idempotent upsert by key → safe replays, applies latest change.
- **"CDF?"** Row-level change feed for incremental downstream consumption.
- **"Schema enforcement vs evolution?"** Reject mismatches by default; opt-in `mergeSchema` to add cols.
</details>

### Round 3.3 — Customer-facing scenario (15 min)
**Q:** "A customer says their Databricks job is slow and expensive. How do you help?"
<details><summary>Model answer</summary>

Diagnose before prescribing. Pull the **Spark UI / query profile**: look for skew (straggler tasks),
excessive shuffle, **small files** in Bronze, spill/GC, and whether they're on an oversized all-purpose
cluster. Quick wins: enable **AQE + Photon**, switch prod jobs to **job clusters** with autoscaling and
auto-termination, `OPTIMIZE`/Z-ORDER hot tables, partition/prune correctly, broadcast small dims, cache
only reused DataFrames, avoid Python UDFs. Then right-size the cluster and use spot for non-critical.
Frame it as cost *and* performance — exactly what a platform SA does. Confirm with before/after metrics.
</details>

### Round 3.4 — Communication (15 min)
**Q:** "Explain the lakehouse to a VP who only knows data warehouses."
<details><summary>Model answer</summary>

"A warehouse is great for fast SQL but locks data in a proprietary, pricey system, and you keep a second
copy in a lake for ML. A **lakehouse** puts warehouse capabilities — ACID transactions, governance, fast
SQL — directly on cheap, open cloud storage using Delta. So you keep **one** copy of data that serves
both BI and ML, with no vendor lock-in, lower cost, and real-time + batch on the same tables. You get the
reliability of a warehouse with the scale and openness of a lake." (Analogy-driven, no jargon — vendor
SAs are scored on this.)
</details>

---

## MOCK 4 — Consulting / Azure Data Engineer (45 min)

### Round 4.1 — Screening Q&A (10 min)
<details><summary>Rapid answers</summary>

- **"Years in data engineering?"** ~8 years across finance, healthcare, insurance, pharma.
- **"ADF vs Databricks?"** ADF orchestrates + moves; Databricks transforms at scale; ADF triggers
  Databricks notebooks.
- **"Synapse dedicated vs serverless?"** Provisioned MPP vs on-demand SQL over lake files.
- **"DP-203?"** Yes — Azure Data Engineer Associate.
- **"Sponsorship?"** H-1B transfer (see Module 09 script).
- **"Comfortable client-facing?"** Yes — I've presented platforms and trained 150+ business users.
</details>

### Round 4.2 — Azure scenario (20 min)
**Q:** "A client wants to move their on-prem SQL Server reporting to Azure with minimal disruption."
<details><summary>Model answer</summary>

Module 06 **A1**: Self-hosted IR in ADF extracts on-prem SQL → ADLS **Bronze** (full then CDC);
Databricks PySpark builds Silver/Gold Delta star schema (re-implementing SSIS as code); serve via Synapse
serverless / Fabric Warehouse + Power BI semantic models (Direct Lake). Run **parallel**, reconcile
control totals, then cut over. Govern with Key Vault, managed identities, Purview lineage; CI/CD via Azure
DevOps. Minimal disruption = parallel run + phased cutover + reconciliation. (Tie to my Assurant 8TB
on-prem→Synapse migration.)
</details>

### Round 4.3 — Behavioral (15 min)
**Q:** "Tell me about working with a difficult stakeholder / changing requirements." → Use the
conflict story (Module 09 Q6) or ambiguity story (Q10). Emphasize: align on the goal, make trade-offs
visible with data, deliver an iterative slice, keep the relationship intact.

---

## Self-scoring rubric (grade each mock 1–5)

| Dimension | 1 (weak) | 5 (strong) |
|---|---|---|
| **Correctness** | Wrong/buggy | Correct, handles edge cases |
| **Clarity** | Rambling | Structured, narrates thinking |
| **Trade-offs** | States one option | Compares options + justifies |
| **Seniority signals** | Only happy path | Idempotency, scale, failure, cost, governance |
| **Metrics in stories** | Vague | Quantified + defensible follow-ups |
| **Communication** | Jargon dump | Tailored to audience |

**Target before real interviews:** consistent 4–5 across all dimensions on Mocks 1–3, and a clean,
confident sponsorship + comp conversation.

---

## Final-week checklist
- [ ] Re-do all 5 SQL patterns (Module 01) and 6 PySpark problems (Module 02) **cold**.
- [ ] Narrate the Spark job lifecycle + Delta ACID (Module 03) from memory.
- [ ] Draw your reference architecture (Module 06) in 90 seconds.
- [ ] Deliver all 6 STAR stories (Module 09) in ≤90s each, with numbers.
- [ ] Give the honest-but-strong answer for **each** gap: dbt, Snowflake, Scala, Airflow (Module 07).
- [ ] Run one full mock out loud the day before — then rest.

You've got the experience. This course just makes sure the interviewer **sees** it. Good luck.
