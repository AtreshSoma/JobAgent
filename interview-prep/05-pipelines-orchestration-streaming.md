# Module 05 — Pipelines, Orchestration & Streaming

**Why:** ETL (159), data pipeline (151), ELT (120), Airflow (112), streaming (69), Kafka (43). Every
DE role tests pipeline design thinking: idempotency, scheduling, failure handling, batch vs streaming,
CDC. (Airflow is one of your **gap areas** — concepts here, hands-on crash course in
[Module 07](07-gap-areas-dbt-snowflake-scala-airflow.md).)

---

## Topics to prepare
- **ETL vs ELT** and why ELT won in the cloud.
- **Batch vs micro-batch vs streaming**; latency/throughput trade-offs.
- **Idempotency, exactly-once vs at-least-once**, dedup, deterministic re-runs.
- **Orchestration:** DAGs, dependencies, scheduling, retries, backfills, SLAs, sensors, alerting.
- **CDC (Change Data Capture):** log-based vs query-based; tools (Debezium, ADF, Fivetran).
- **Incremental loading:** watermarks/high-water marks, CDF, merge/upsert.
- **Streaming:** Kafka/Event Hub, Spark Structured Streaming, windowing, watermarks, checkpointing,
  late data, **Lambda vs Kappa**.
- **Data quality:** validations, expectations, schema/contract enforcement, dead-letter queues.
- **Observability:** lineage, freshness SLAs, monitoring, alerting, reprocessing.

---

## ETL vs ELT (have a crisp answer)
- **ETL:** transform **before** loading (legacy SSIS/Informatica; transform on a separate engine). Good
  when the target is expensive/rigid or you must mask/aggregate before landing.
- **ELT:** load raw into a cheap, scalable store/warehouse first, **then transform in-place** with the
  warehouse/Spark's compute (dbt, Spark SQL, Snowflake). Wins because cloud storage is cheap, compute
  scales elastically, you keep raw for replay, and transforms are version-controlled SQL.
- Your medallion architecture **is** ELT: land raw (Bronze), transform in Silver/Gold.

## Idempotency — the senior signal
> "A pipeline is **idempotent** if re-running it produces the same result without duplicates or
> corruption." Interviewers probe this constantly because retries/backfills are inevitable.

How you achieve it:
- **MERGE/upsert on a business key** instead of blind append.
- **Overwrite by partition** (`replaceWhere` / dynamic partition overwrite) for the affected window.
- **Deterministic transforms** + **checkpoints** (Autoloader/Structured Streaming) for exactly-once.
- **Idempotency keys** for API sinks; dedup on `event_id`.

## Exactly-once vs at-least-once
- **At-least-once:** no message lost, but duplicates possible → you must dedup downstream.
- **Exactly-once (effectively-once):** Structured Streaming achieves this with **checkpointing +
  idempotent sinks (Delta)** — offsets and results commit atomically so replays don't double-count.
- True end-to-end exactly-once needs an idempotent/transactional sink; otherwise design for
  at-least-once + dedup.

---

## Orchestration concepts (Airflow vocabulary you must speak)
- **DAG** = Directed Acyclic Graph of tasks with dependencies (`a >> b >> c`).
- **Operator/Task** = a unit of work (Python, SQL, Spark submit, sensor).
- **Schedule** = cron/interval; **execution_date / logical date** = the data interval the run
  represents (key for backfills).
- **Backfill** = run historical intervals to (re)populate past data.
- **Sensor** = waits for a condition (file arrives, partition ready) — prefer **deferrable/reschedule**
  sensors to avoid wasting workers.
- **Retries + exponential backoff**, **SLA**, **alerting**, **idempotent tasks** so retries are safe.
- **XCom** = small inter-task message passing (don't pass big data through it — pass pointers/paths).

> In interviews say: "I've orchestrated with **ADF pipelines, Databricks Workflows, Azure DevOps, and
> GitHub Actions**; the Airflow concepts map 1:1 — DAGs, operators, sensors, backfills, retries — and
> I'm comfortable picking it up." (See Module 07 for a concrete Airflow DAG.)

---

## CDC (Change Data Capture)
- **Why:** propagate only inserts/updates/deletes from a source DB instead of full reloads.
- **Log-based** (Debezium, Azure SQL CDC, GoldenGate): reads the DB transaction log — low impact,
  captures deletes, near-real-time. Preferred.
- **Query-based** (high-water-mark on `updated_at`): simpler, but misses hard deletes and needs a
  reliable change timestamp.
- **Landing pattern:** CDC events → Bronze (append) → `MERGE` into Silver by primary key, applying the
  latest change per key (handle out-of-order with the change LSN/timestamp).

---

## Streaming essentials

### Structured Streaming model
- Treats a stream as an **unbounded table**; each trigger processes a **micro-batch** (or continuous).
- **Checkpointing** stores offsets + state for fault tolerance and exactly-once into Delta.
- **Output modes:** append, update, complete.
- **Triggers:** default (ASAP micro-batch), fixed interval, `availableNow` (drain then stop),
  continuous (low-latency, limited ops).

### Windowing & watermarks
- **Tumbling** (fixed, non-overlapping), **sliding** (overlapping), **session** (gap-based) windows.
- **Event time vs processing time** — always aggregate on **event time** for correctness.
- **Watermark** = "I won't wait for data later than X" → bounds state size and decides when a window
  is final; late data beyond the watermark is dropped (or sent to a late/dead-letter path).

### Lambda vs Kappa
- **Lambda:** separate **batch** (accurate, reprocessable) + **speed/streaming** (low latency) layers,
  merged at serving. More code, two paths to maintain.
- **Kappa:** **one streaming** pipeline; reprocess by replaying the log. Simpler; viable when your
  stream store (Kafka) retains history. Modern lakehouse + Delta blurs the two (same code for batch &
  stream).

### FAQ (rapid)

**Q: Kafka core concepts?**
A: **Topics** split into **partitions** (ordering + parallelism unit); **producers** write, **consumer
groups** read with each partition consumed by one consumer in the group; **offsets** track position;
**replication factor** for durability. Ordering is guaranteed **within a partition** only.

**Q: How do you guarantee ordering for a key in Kafka?**
A: Use the **key** so all events for that key hash to the same partition (ordering within a partition).
Cross-partition global ordering isn't guaranteed by design.

**Q: How do you handle late-arriving data in streaming?**
A: Use **event-time windows + watermarks**; allow lateness up to the watermark to update windows,
route data later than the watermark to a **late/dead-letter** sink for separate handling or batch
reconciliation.

**Q: Event Hub vs Kafka? (you have Event Hub)**
A: Azure Event Hubs is a managed, partitioned event-ingestion service with a **Kafka-compatible
endpoint** — same mental model (partitions, consumer groups, offsets/checkpoints). I've ingested from
Event Hub into Structured Streaming; the Kafka API is a small step.

**Q: How do you backfill a streaming pipeline?**
A: Re-read the source from an earlier offset/log retention (Kappa-style replay) or run the equivalent
**batch** job over the historical window writing to the same idempotent Delta sink via MERGE/replaceWhere
so it converges without duplicates.

**Q: How do you enforce data quality in a pipeline?**
A: Schema enforcement at ingest, **expectations** (DLT `@dlt.expect` / Great Expectations / dbt tests)
on nullability, ranges, referential integrity, uniqueness; quarantine failing rows to a dead-letter
table; track freshness and row-count anomalies; alert on breach. I built Medallion-layer quality
scorecards that moved stakeholder confidence from 68% → 94%.

---

## Mock pipeline problems (with answers)

**P1 — "Design a daily pipeline ingesting 500GB of transactions into a reporting warehouse."**
> Land files in cloud storage; **Autoloader** ingests new files into **Bronze** (append + `ingest_ts`,
> schema evolution on, exactly-once via checkpoint). **Silver** job reads incrementally, casts/validates
> with expectations, dedups on transaction id by latest ingest, `MERGE`s into Silver. **Gold** builds
> star-schema facts/aggregates via partition overwrite (`replaceWhere` on the date). Orchestrate with
> Workflows/ADF: dependency Bronze→Silver→Gold, retries with backoff, freshness SLA + alerting, and
> `OPTIMIZE`/Z-ORDER on Gold. Idempotency from MERGE + checkpoints means any retry/backfill is safe.
> This mirrors my Microsoft pipeline that took reporting from 5 days to 4 hours on 500GB/day.

**P2 — "A nightly job failed at 2am and retried 3×, creating duplicate rows. Prevent it."**
> The job was **append-based** (not idempotent). I'd switch the sink to a Delta **MERGE** on the
> business key (or `replaceWhere` overwrite of the target partition) so re-runs converge. Add a
> processing checkpoint/high-water mark so it resumes from the last committed offset, and make the
> transform deterministic. Now 3 retries = same final state, zero duplicates.

**P3 — "Source DB has 5M-row tables; full reload each night is too slow. Options?"**
> Move to **incremental/CDC**. Best: **log-based CDC** (Debezium/Azure SQL CDC) streaming changes to
> Bronze, then `MERGE` by primary key into Silver — captures updates *and* deletes in near-real-time.
> If CDC isn't available, query-based incremental on a reliable `updated_at` high-water mark (but it
> misses hard deletes — handle with periodic reconciliation). Either way, only changed rows move.

**P4 — "Real-time fraud alerts within seconds — batch or streaming, and how?"**
> **Streaming.** Kafka/Event Hub ingests transactions; Spark Structured Streaming scores each event
> against rules/a model using **event-time windows + watermark** for velocity features (e.g., "N txns
> in 5 min per card"); write alerts to a low-latency sink and the full stream to Delta Bronze for
> replay/training. Checkpointing gives exactly-once into Delta. For accuracy I'd keep a nightly **batch
> reconciliation** (Lambda) or a Kappa replay to correct any late/dropped data.

➡ Next: [06-azure-fabric-platform.md](06-azure-fabric-platform.md)
