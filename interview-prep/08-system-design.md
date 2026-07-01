# Module 08 — Data Engineering System Design

**Why:** Big tech (Amazon, Microsoft, Dropbox, Reddit, Roblox, Samsara) and platform vendors
(Databricks, MongoDB) gate senior offers on a system-design round. They test whether you can take a
vague prompt, **ask the right questions**, justify trade-offs, and design something that scales and
survives failure. This is also where your architecture experience shines.

---

## The framework (use this every single time)

> Spend the first 5 minutes on **requirements**, not architecture. Most candidates fail by drawing
> boxes before knowing the problem.

**1. Clarify requirements (ask, don't assume)**
- **Functional:** What sources? What consumers (BI, ML, API, ops)? What questions must it answer?
- **Scale:** Volume (GB/TB/PB?), velocity (rows/sec, events/day), growth.
- **Latency / freshness:** real-time (seconds), near-real-time (minutes), or daily batch?
- **Consistency / accuracy:** exactly-once? acceptable lag? reprocessing needs?
- **SLAs:** uptime, freshness, query latency.
- **Constraints:** cloud, budget, existing stack, team skills, compliance (PII/HIPAA/SOX).

**2. State assumptions & estimate scale**
- Back-of-envelope: events/day × bytes = storage/day; peak vs average throughput; retention.

**3. High-level architecture (the 5 stages)**
```
Ingestion → Storage → Processing/Transform → Serving → Orchestration + Governance
```

**4. Drill into components & justify trade-offs**
- Batch vs streaming; file format; partitioning; modeling; compute engine; sink.

**5. Address the cross-cutting concerns (this is what makes you "senior")**
- **Idempotency & exactly-once**, **schema evolution**, **data quality**, **backfills**,
  **observability/monitoring**, **cost**, **security/governance**, **failure recovery**, **scaling**.

**6. Summarize & note future improvements.**

---

## The reusable building blocks (your toolbox)

| Need | Options (pick + justify) |
|---|---|
| Ingestion (batch) | ADF/Fivetran/Autoloader, `COPY INTO` |
| Ingestion (stream) | Kafka / Event Hub / Kinesis + Structured Streaming |
| CDC | Debezium / native DB CDC → Bronze → MERGE |
| Lake storage | ADLS/S3 + **Delta/Iceberg** (ACID, open) |
| Warehouse | Snowflake / Synapse / BigQuery / Fabric Warehouse |
| Transform | Spark/Databricks (big data), dbt (SQL-ELT) |
| Orchestration | Airflow / ADF / Databricks Workflows / Dagster |
| Serving — BI | Power BI semantic models / Looker |
| Serving — low latency | Key-value/OLAP store (Redis, Druid, ClickHouse, Cosmos DB) |
| Quality | DLT expectations / dbt tests / Great Expectations |
| Governance | Unity Catalog / Purview, lineage, RBAC |

---

## Worked example 1 — Design a data warehouse / analytics platform for an e-commerce company

**Clarify:** sources (orders OLTP DB, web/clickstream events, ad spend API, inventory); consumers
(exec dashboards, marketing, finance, DS); freshness (dashboards daily, some near-real-time);
scale (~50M events/day, ~5TB historical).

**Design:**
- **Ingestion:** CDC (Debezium/native) from the orders DB → Bronze; **clickstream via Kafka/Event Hub →
  Structured Streaming** → Bronze; APIs via daily ADF/Airflow batch.
- **Storage:** ADLS/S3 + **Delta**, medallion zones. Partition events by `event_date`.
- **Transform:** Spark/dbt builds **Silver** (clean, dedup, conform keys) then **Gold** star schemas:
  `fct_orders` (grain = order line), `fct_web_events`, conformed `dim_customer` (SCD2), `dim_product`
  (SCD2), `dim_date`.
- **Serving:** Power BI / Snowflake-style warehouse for BI; a feature table for DS.
- **Orchestration:** Airflow/Workflows DAG Bronze→Silver→Gold with retries, freshness SLAs.
- **Cross-cutting:** MERGE-based idempotency; expectations + dbt tests; OPTIMIZE/Z-ORDER hot Gold
  tables; Unity Catalog governance; monitoring on freshness/row-count anomalies.

**Trade-offs to voice:** ELT over ETL (cheap storage, replayable raw); Delta for ACID on the lake
(one copy for BI+ML) vs a closed warehouse; partitioning by date for pruning but watch small files.

---

## Worked example 2 — Real-time analytics / metrics pipeline (e.g., live dashboard of events)

**Clarify:** latency target (seconds), metrics (counts, unique users, top-N), accuracy vs speed,
volume (100K events/sec peak), late data tolerance.

**Design (Kappa-leaning):**
- **Ingest:** producers → **Kafka** (partitioned by entity key for ordering + parallelism).
- **Process:** **Spark Structured Streaming** (or Flink) with **event-time tumbling windows +
  watermark**; compute windowed aggregates; **checkpointing** for exactly-once into Delta.
- **Serve:** write aggregates to a **low-latency OLAP store** (Druid/ClickHouse/Cosmos DB) for the
  dashboard; raw stream also lands in Delta Bronze for replay/backfill.
- **Accuracy:** unique counts via HyperLogLog (`approx_count_distinct`) for speed; nightly **batch
  reconciliation** (Lambda) corrects approximations and late data.

**Cross-cutting:** handle **late data** beyond watermark via a late/dead-letter path; **backpressure**
via Kafka buffering; scale by adding partitions + executors; monitor consumer lag.

**Trade-off to voice:** Kappa (one streaming path, replay from Kafka) is simpler to maintain; add a
batch layer (Lambda) only if you need exact historical correctness the stream can't guarantee.

---

## Worked example 3 — Ingest from 100s of source tables (metadata-driven framework)

**Clarify:** number of tables, schema drift frequency, full vs incremental, SLAs.

**Design:**
- A **control/metadata table** lists each source (connection, table, load type, watermark column, keys).
- A **single parameterized pipeline** (ADF ForEach / Airflow dynamic task mapping) iterates the
  control table: extract → land Bronze → MERGE Silver. No per-table code.
- **Incremental** via high-water mark or CDC; **schema evolution** handled with `mergeSchema`.
- **Quality + lineage** logged per table; failures isolated (one bad table doesn't fail the batch).

**Why they love this:** it shows you build **scalable frameworks**, not 100 copy-paste pipelines —
exactly the metadata-driven pattern senior DEs are expected to know.

---

## Worked example 4 — CDC pipeline from an OLTP database to the lakehouse

**Design:**
- **Log-based CDC** (Debezium → Kafka, or native DB CDC) captures inserts/updates/**deletes**.
- Land change events append-only in **Bronze** with the change LSN/timestamp and op type.
- **MERGE into Silver** by primary key, applying the **latest** change per key (order by LSN); handle
  deletes (soft-delete flag or physical delete) and **out-of-order** events.
- Optionally maintain **SCD2 history** in a separate Silver table for point-in-time analysis.

**Cross-cutting:** idempotent MERGE (replays safe), schema drift handling, initial **snapshot +
incremental** bootstrap, monitoring replication lag.

---

## Worked example 5 — Data quality / observability framework

**Design layers:**
- **Schema/contract** enforcement at ingest (reject or quarantine).
- **Expectations/tests:** nullability, ranges, uniqueness, referential integrity, freshness, row-count
  vs forecast (anomaly detection). Tools: DLT `expect`, dbt tests, Great Expectations.
- **Quarantine / dead-letter** failing rows; don't fail the whole batch silently.
- **Metrics + alerting:** freshness SLA, volume drift, null-rate spikes → alert + auto-reprocess.
- **Lineage** (Unity Catalog/Purview) so you can trace and impact-analyze.

This is your real story: Medallion-layer **quality scorecards** that took stakeholder confidence from
68% → 94%, plus SOX audit automation at 99.97% accuracy.

---

## Worked example 6 — Batch + streaming unification (Lambda vs Kappa decision)

**Prompt:** "We need both historical accuracy and real-time freshness."
- **Lambda:** batch layer (accurate, reprocessable Delta) + speed layer (streaming approximations),
  merged at serving. Cost: two codebases, reconciliation logic.
- **Kappa:** single streaming pipeline; reprocess by replaying Kafka/Delta history. Cost: needs log
  retention; some heavy historical recompute is awkward.
- **Modern lakehouse answer:** Delta + Structured Streaming lets you run the **same transformation code**
  for batch and stream (`trigger=availableNow` for batch, continuous for stream), collapsing much of
  Lambda's duplication. Choose based on accuracy guarantees and team complexity budget.

---

## Cross-cutting checklist (run through these out loud — earns senior signal)

- [ ] **Idempotency:** MERGE/replaceWhere + checkpoints → safe retries/backfills.
- [ ] **Exactly-once vs at-least-once:** stated and justified.
- [ ] **Schema evolution:** how new/changed columns are handled.
- [ ] **Data quality:** validations, quarantine, alerting.
- [ ] **Backfill/reprocessing:** how you rebuild history.
- [ ] **Partitioning & file sizing:** pruning + small-files mitigation (OPTIMIZE).
- [ ] **Scaling:** more partitions/executors; skew handling (salting/AQE).
- [ ] **Observability:** lineage, freshness, monitoring, on-call alerts.
- [ ] **Cost:** storage tiers, job vs all-purpose clusters, auto-suspend, scanned-data reduction.
- [ ] **Security/governance:** PII handling, RBAC, encryption, masking, compliance (HIPAA/SOX/GDPR).
- [ ] **Failure recovery:** retries, checkpoints, replay, DLQ.

---

## Common system-design FAQ

**Q: How do you decide batch vs streaming?**
A: By **freshness requirement vs complexity/cost**. If business value needs sub-minute data
(fraud, live ops), stream. If hourly/daily is fine (most reporting), batch is simpler, cheaper, easier
to test and backfill. Don't stream by default — justify it.

**Q: How do you choose a file format?**
A: **Columnar (Parquet)** for analytics (compression, column pruning), wrapped in **Delta/Iceberg** for
ACID + time travel. Avro/JSON for row-oriented streaming payloads/landing. Never CSV for big analytical
storage.

**Q: How do you choose partition keys?**
A: On the column(s) most used in filters/joins (often **date**), with cardinality that yields
reasonably sized files (avoid millions of tiny partitions). Combine with clustering/Z-ORDER for
secondary filter columns.

**Q: How do you handle PII / compliance in the design?**
A: Classify and tag PII; encrypt at rest/in transit; mask or tokenize; row/column-level security; least
-privilege RBAC; audit access (Unity Catalog/Purview); data retention/right-to-be-forgotten via Delta
`DELETE`/`MERGE`. I've done GDPR classification + RLS for 8 international markets at Assurant.

➡ Next: [09-behavioral-and-star.md](09-behavioral-and-star.md)
