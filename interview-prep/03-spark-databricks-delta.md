# Module 03 — Spark Internals, Databricks & Delta Lake

**Why:** Spark (149), Databricks (84), Delta Lake (41), lakehouse (51). For Databricks/MongoDB-style
vendors and any Azure Databricks role, **internals** separate seniors from juniors. This is your home
turf — be able to go three "why?" levels deep.

---

## Part A — Spark architecture & execution

### Topics to prepare
- **Cluster anatomy:** Driver, Executors, Cluster Manager (YARN/K8s/Databricks), Tasks, Cores, Slots.
- **Execution hierarchy:** Job → Stage → Task. **Stage boundary = shuffle.**
- **Catalyst optimizer** (logical → optimized logical → physical plans) and **Tungsten** (whole-stage
  codegen, off-heap memory).
- **Narrow vs wide transformations** (shuffle or not).
- **Partitioning & parallelism**, `spark.sql.shuffle.partitions` (default 200).
- **Joins:** broadcast hash, shuffle hash, **sort-merge** (default for large), skew handling.
- **Memory model:** execution vs storage memory, spill, OOM causes.
- **AQE** and **DPP** (dynamic partition pruning).
- **File layout:** small-files problem, partitioning, bucketing, compaction.

### How a Spark job runs (be able to narrate this)
1. You call an **action** → Spark builds a **DAG** of stages from the lineage.
2. DAG is split into **stages at each shuffle boundary**; each stage = a set of **tasks** (one per
   partition).
3. The **driver** schedules tasks onto **executor** slots; tasks read their partition, run the
   stage's pipelined operators, and write shuffle output if there's a downstream stage.
4. **Catalyst** optimizes the logical plan (predicate pushdown, column pruning, join reordering);
   **Tungsten** generates compact bytecode and manages off-heap memory.

### FAQ (rapid)

**Q: Narrow vs wide transformation?**
A: **Narrow** = each output partition depends on one input partition (`map`, `filter`, `select`) — no
shuffle. **Wide** = output partition depends on many input partitions (`groupBy`, `join`, `distinct`)
— requires a shuffle.

**Q: What is a shuffle and why is it expensive?**
A: Redistributing data across partitions/executors by key. It serializes data, writes shuffle files to
local disk, and transfers over the network — disk + network + serialization cost. Minimize wide ops,
filter early, broadcast small tables.

**Q: Driver vs executor responsibilities?**
A: **Driver** runs your program, builds the DAG, schedules tasks, holds the `SparkSession`, collects
results. **Executors** run tasks and cache data. `collect()` of a huge DF can OOM the **driver**.

**Q: Default join strategy and how to change it?**
A: **Sort-merge join** for two large tables; **broadcast hash join** when one side is small. Force
broadcast with `F.broadcast(df)` or tune `spark.sql.autoBroadcastJoinThreshold`.

**Q: Common OOM causes?**
A: `collect()`/`toPandas()` of big data to driver; skewed keys overloading one executor; huge
`groupBy`/`collect_list`; too few partitions; exploding joins. Fixes: more partitions, salting,
broadcast, avoid collect, increase memory/cores.

**Q: `spark.sql.shuffle.partitions` — why tune it?**
A: Default 200. Too few → big partitions spill/OOM; too many → tiny tasks + scheduling overhead. AQE
auto-coalesces post-shuffle partitions, reducing manual tuning.

**Q: How do you debug a slow Spark job?**
A: Open the **Spark UI** → find the slow **stage** → check task duration distribution (skew?), shuffle
read/write size, spill, GC time. Look for one straggler task (skew) or massive shuffle (missing
broadcast/filter).

**Q: Predicate pushdown & partition pruning?**
A: Catalyst pushes filters down to the data source so Parquet/Delta only reads matching row groups and
**only the partition directories** that satisfy the filter — less I/O. DPP does this dynamically using
the dimension side of a join.

---

## Part B — Delta Lake internals

### Topics to prepare
- **Transaction log (`_delta_log`):** JSON commits + Parquet checkpoints; **ACID** via optimistic
  concurrency.
- **Time travel:** query by version / timestamp.
- **`MERGE`/upsert**, `UPDATE`, `DELETE` (vs immutable Parquet).
- **Schema enforcement** & **schema evolution** (`mergeSchema`).
- **`OPTIMIZE`** (compaction) + **Z-ORDER** (multi-dim clustering) / Liquid Clustering.
- **`VACUUM`** (retention) and the dangers of short retention.
- **CDF** (Change Data Feed) for downstream incremental consumption.
- **Small-files problem** and auto-optimize / auto-compaction.

### How Delta gives you ACID (narrate this)
- Every write creates a new **commit** in `_delta_log` listing which Parquet files are **added** and
  **removed**. Readers see a consistent snapshot (the set of valid files at a version).
- Concurrency uses **optimistic concurrency control**: a writer reads a snapshot, stages changes, and
  commits only if no conflicting commit happened; otherwise it retries.
- **Time travel** works because old files aren't deleted immediately — you can read version N or a
  timestamp. `VACUUM` physically removes files older than the retention window.

### FAQ (rapid)

**Q: Delta vs Parquet?**
A: Delta = Parquet **+ transaction log**. That log adds ACID transactions, `MERGE`/`UPDATE`/`DELETE`,
time travel, schema enforcement/evolution, and reliable concurrent reads/writes. Plain Parquet has
none of those guarantees.

**Q: What does `OPTIMIZE` do and when do you Z-ORDER?**
A: `OPTIMIZE` compacts many small files into right-sized files (better scan throughput). `ZORDER BY
(col)` co-locates data with similar values so filters on those columns skip more files (data skipping).
Z-ORDER on the columns you filter/join on most.

**Q: `VACUUM` risk?**
A: `VACUUM` deletes files no longer referenced, beyond the retention period (default 7 days). Setting
retention too low breaks time travel and can corrupt **concurrent readers/long-running queries**.
Don't VACUUM with `RETAIN 0 HOURS` in production.

**Q: How does `MERGE` enable idempotency / CDC?**
A: `MERGE` matches on keys and updates/inserts/deletes accordingly, so replaying the same source batch
converges to the same state — safe retries and exactly-once-ish upserts.

**Q: Schema enforcement vs evolution?**
A: Enforcement rejects writes whose schema doesn't match (prevents silent corruption). Evolution
(`mergeSchema`/`overwriteSchema`) lets you intentionally add columns. You want enforcement by default,
evolution on purpose.

**Q: What is Change Data Feed (CDF)?**
A: Delta can emit row-level changes (insert/update/delete with `_change_type`) so downstream jobs
process **only what changed** instead of full reloads — powers incremental Silver→Gold.

**Q: Liquid Clustering vs partitioning + Z-ORDER?**
A: Liquid Clustering is a newer Databricks feature that replaces static `partitionBy` + Z-ORDER with
adaptive clustering keys — avoids over/under-partitioning and the small-files trap, and you can change
keys without rewriting layout.

---

## Part C — Databricks platform

### Topics to prepare
- **Delta Live Tables (DLT):** declarative pipelines, expectations (data quality), auto-orchestration,
  streaming + batch.
- **Workflows / Jobs:** task orchestration, dependencies, retries, alerts.
- **Unity Catalog:** governance, three-level namespace (`catalog.schema.table`), lineage, access
  control, audit.
- **Cluster types:** all-purpose vs **job clusters**, **Photon** engine, autoscaling, spot/on-demand.
- **Databricks Asset Bundles (DAB):** code + config as IaC for CI/CD.
- **Autoloader (`cloudFiles`):** incremental file ingestion with schema inference/evolution and
  exactly-once via checkpointing.

### FAQ (rapid)

**Q: What is DLT and why use it?**
A: Delta Live Tables is a **declarative** framework: you define `@dlt.table` transformations and
**expectations** (`@dlt.expect`) for quality; DLT manages dependencies, orchestration, retries,
incremental processing, and observability automatically. Less plumbing than hand-built notebooks +
Workflows.

**Q: What problem does Autoloader solve?**
A: Efficiently ingesting **new files** from cloud storage without re-listing the whole directory. It
tracks processed files (checkpoint), supports **schema inference & evolution**, and gives exactly-once
ingestion into Bronze.

**Q: Job cluster vs all-purpose cluster?**
A: **Job clusters** spin up for a scheduled job and terminate after (cheaper, isolated). **All-purpose**
clusters are shared/interactive for development. Production jobs should use job clusters.

**Q: What does Unity Catalog give you?**
A: Centralized governance across workspaces — fine-grained access control, **column/row-level
security**, automatic **lineage**, audit logs, and a unified `catalog.schema.table` namespace. Replaces
the legacy Hive metastore per-workspace model.

**Q: What is Photon?**
A: A vectorized C++ execution engine for Databricks that accelerates SQL and DataFrame workloads,
especially scans, joins, and aggregations on Delta. Faster + cheaper for the same query.

---

## Mock deep-dive (full answers)

**D1 — "Walk me through what happens when you run `df.groupBy('k').count().show()`."**
> The `groupBy().count()` are lazy transformations — Spark just extends the logical plan. `show()` is
> the action that triggers execution. Catalyst optimizes the plan and Spark splits it into two stages
> around the shuffle that `groupBy` requires. Stage 1 reads the source partitions and does a **map-side
> partial aggregation** (combiner) to reduce data. The shuffle repartitions by `k`'s hash so all rows
> for a key land in the same partition. Stage 2 does the final aggregation per key. With AQE on, Spark
> coalesces the 200 default shuffle partitions down to what the data actually needs, and would split
> any skewed partition. `show()` only pulls the first 20 rows back to the driver.

**D2 — "Your nightly Silver job suddenly takes 4× longer. How do you diagnose?"**
> First, Spark UI → which **stage** regressed. I check the task duration histogram: if one task runs
> far longer than the rest, it's **skew** (a hot key after a new data source, maybe lots of NULL join
> keys). I check **shuffle read/write** size for a data-volume jump and **spill** for memory pressure.
> Common root causes: (1) skew → salt the key or enable AQE skew join; (2) small-files explosion in
> Bronze → run `OPTIMIZE`/enable auto-compaction; (3) a broadcast that stopped happening because the
> "small" table grew past the threshold → re-hint or raise the threshold; (4) lost partition pruning
> because a filter became non-sargable. I'd confirm with the plan (`df.explain()`).

**D3 — "How do you design an idempotent, incremental Bronze→Silver→Gold pipeline on Delta?"**
> **Bronze:** Autoloader ingests raw files exactly-once with checkpointing, schema evolution on,
> minimal transformation, append-only with an `ingest_ts`. **Silver:** read Bronze incrementally (CDF
> or checkpoint), cast types, validate with expectations, dedup on the business key by latest
> `ingest_ts`, then `MERGE` into the Silver Delta table so re-runs are idempotent. **Gold:** aggregate
> Silver into star-schema facts/dims or semantic models, again via `MERGE`/overwrite of affected
> partitions. Orchestrate with DLT or Workflows, add retries, and `OPTIMIZE`/Z-ORDER the
> heavily-queried Gold tables. Idempotency comes from MERGE keys + checkpoints, so any retry or
> backfill converges to the same state.

➡ Next: [04-data-modeling-warehousing.md](04-data-modeling-warehousing.md)
