# Module 07 — Gap Areas: dbt, Snowflake, Scala & Airflow

**Why this is the most important module for your offer rate:** your highest *unmet* demand signals are
**Scala (172), Airflow (112), dbt (80), and Snowflake** (many dedicated roles). You don't need to be an
expert — you need to (1) speak the vocabulary fluently, (2) read the code without panic, and (3) answer
"Have you used X?" in a way that converts. Each section below is a crash course + an honest, strong
answer script.

> **Golden rule for gaps:** never say a flat "no." Say what you've done that's **equivalent**, show you
> understand the tool's concepts, and express concrete readiness. Tools are learnable in days; concepts
> are what they're really testing.

---

## 7.1 dbt (data build tool) — demand 80×

### The mental model
dbt is the **T in ELT**: you write **SELECT statements as models**; dbt handles dependency ordering,
materialization, testing, and docs. It compiles Jinja-templated SQL and runs it **in your warehouse**
(Snowflake/BigQuery/Databricks/Synapse). It's basically "software engineering for SQL transforms":
version control, modularity, tests, CI/CD.

### Core concepts (memorize the vocabulary)
- **Model** = a `.sql` file = one `SELECT` → materialized as a view/table. Files form a DAG via refs.
- **`ref()` / `source()`** = `{{ ref('stg_orders') }}` builds dependencies automatically; `source()`
  points at raw tables (and powers source freshness checks).
- **Materializations:** `view` (default), `table`, **`incremental`** (only process new rows),
  `ephemeral` (inlined CTE). Set via `{{ config(materialized='incremental') }}`.
- **Incremental models:** use `is_incremental()` + a filter on a high-water mark; `unique_key` enables
  merge/upsert behavior.
- **Tests:** built-in **schema tests** (`unique`, `not_null`, `accepted_values`, `relationships`) in
  YAML, plus **singular** (custom SQL) and **generic** tests. This is dbt's killer feature for DQ.
- **Snapshots** = dbt's **SCD Type 2** implementation (`strategy: timestamp|check`).
- **Seeds** = small CSVs loaded as tables (lookups).
- **Macros** = reusable Jinja/SQL functions (DRY).
- **Sources + freshness** = declare raw tables and assert data isn't stale.
- **Docs + lineage** = `dbt docs generate` builds a browsable DAG and column-level docs.
- **dbt project layout:** `staging` (1:1 cleaned source) → `intermediate` → `marts` (star schema). This
  maps **directly** onto your **Bronze → Silver → Gold** medallion mental model.

### Minimal example (be able to read/write this)
```sql
-- models/staging/stg_orders.sql
with src as (select * from {{ source('shop', 'orders') }})
select
  order_id,
  customer_id,
  cast(order_ts as timestamp) as order_ts,
  cast(amount as numeric(18,2)) as amount
from src
where amount is not null
```
```sql
-- models/marts/fct_orders.sql
{{ config(materialized='incremental', unique_key='order_id') }}
select * from {{ ref('stg_orders') }}
{% if is_incremental() %}
  where order_ts > (select coalesce(max(order_ts), '1900-01-01') from {{ this }})
{% endif %}
```
```yaml
# models/staging/_staging.yml  — tests as data contracts
models:
  - name: stg_orders
    columns:
      - name: order_id
        tests: [unique, not_null]
      - name: customer_id
        tests:
          - relationships: { to: ref('stg_customers'), field: customer_id }
```
Key commands: `dbt run` (build models), `dbt test` (run tests), `dbt build` (run+test+snapshot+seed in
DAG order), `dbt docs generate`.

### How to answer "Have you used dbt?"
> "I haven't run dbt in production, but I know it well conceptually and the transition is small for me.
> My medallion architecture is the same idea — staging→intermediate→marts maps to Bronze→Silver→Gold,
> and I already do dependency-ordered, tested, version-controlled SQL transforms in Databricks and
> Azure DevOps. dbt's `ref()` DAG, incremental models with `is_incremental()` and a `unique_key`,
> schema tests for `unique`/`not_null`/`relationships`, and snapshots for SCD2 all line up with patterns
> I implement today. I'd be productive in dbt within a week."

---

## 7.2 Snowflake — many dedicated roles

### The mental model
A cloud data warehouse with **decoupled storage and compute**. Storage is one shared columnar copy;
**virtual warehouses** (compute clusters) scale independently and can run concurrently without
contention. You pay for storage + per-second compute.

### Architecture (3 layers — say this)
1. **Storage layer** — columnar data in **micro-partitions** (~50–500MB, automatically created),
   compressed, immutable.
2. **Compute layer** — **virtual warehouses** (T-shirt sizes XS…6XL); resize (scale up) for bigger
   queries, multi-cluster (scale out) for concurrency. Independent warehouses share the same data.
3. **Cloud services layer** — optimizer, metadata, security, transactions, result cache.

### Core concepts (vocabulary)
- **Micro-partitions + pruning:** Snowflake stores min/max metadata per micro-partition and **prunes**
  partitions that can't match a filter (like data skipping). No manual indexes.
- **Clustering keys:** for very large tables, define a clustering key so related data co-locates →
  better pruning (analogous to Z-ORDER).
- **Virtual warehouse sizing:** scale **up** (bigger warehouse) for heavy queries; scale **out**
  (multi-cluster) for many concurrent users; auto-suspend/auto-resume to save cost.
- **Time Travel** (query/restore data up to N days ago) + **Fail-safe** (7-day recovery).
- **Zero-copy cloning:** `CREATE TABLE x CLONE y` — instant, no storage cost until changes (great for
  dev/test environments).
- **Streams** = CDC on a table (track changes); **Tasks** = scheduled SQL (build pipelines:
  stream → task → merge).
- **Stages + COPY INTO** = bulk load files; **Snowpipe** = continuous/auto-ingest.
- **Caching:** result cache (identical query), metadata cache, warehouse (local SSD) cache.
- **VARIANT** type + `FLATTEN` for semi-structured JSON.
- **Snowpark** = DataFrame API (Python/Scala/Java) running in Snowflake — close to PySpark ergonomics.

### Snowflake vs Databricks/Delta (you'll be asked to compare)
| | Snowflake | Databricks lakehouse |
|---|---|---|
| Core | SQL data warehouse | Spark + Delta lakehouse |
| Storage | Proprietary micro-partitions | Open Delta/Parquet in your lake |
| Compute | Virtual warehouses (SQL) | Clusters (Spark/Photon, SQL) |
| Strength | Easy SQL, concurrency, low-ops | Big-data eng, ML, streaming, open format |
| Dedup/upsert | `MERGE`, Streams+Tasks | `MERGE`, CDF |

### How to answer "Do you know Snowflake?"
> "I've worked primarily in the Azure/Databricks lakehouse, but Snowflake's concepts map cleanly onto
> what I do. Decoupled storage/compute is like separating ADLS from Databricks clusters; micro-partition
> pruning is data skipping like Delta's; `MERGE`, Time Travel, and zero-copy cloning have direct Delta
> analogues; Streams + Tasks are CDC + scheduled transforms like CDF + Workflows. I write the SQL daily,
> and Snowpark is essentially PySpark. I could be productive immediately and ramp on the cost/warehouse
> tuning specifics quickly."

---

## 7.3 Scala (for Spark) — demand 172×

### Reality check
Most "Scala" requirements are "Scala **for Spark**." The Spark DataFrame API is nearly identical across
Python and Scala — same methods, different syntax. You won't be asked to write advanced functional
Scala for a DE role; you need to **read** it and write basic transformations.

### PySpark → Scala Spark (side by side)
```scala
// Scala Spark — same operations you do in PySpark
import org.apache.spark.sql.functions._
import org.apache.spark.sql.expressions.Window

val w = Window.partitionBy("customer_id").orderBy(col("order_ts").desc)

val latest = orders
  .withColumn("rn", row_number().over(w))
  .filter(col("rn") === 1)      // note: === for column equality, not ==
  .drop("rn")

val agg = df.groupBy("country").agg(sum("amount").as("total"))
agg.write.format("delta").mode("overwrite").saveAsTable("gold.country_totals")
```

### Syntax differences to remember
- `val` (immutable) / `var` (mutable); types after the name: `val x: Int = 5`.
- Column equality is **`===`** (and `=!=` for not-equal); functions need `import ... functions._`.
- `.as("alias")` instead of `.alias()`; string interpolation `s"value=$x"`.
- Methods feel the same: `select`, `withColumn`, `filter`, `groupBy`, `join`, `agg`.
- Anonymous functions: `xs.map(x => x * 2)`; `case class` for typed rows/Datasets.

### How to answer "Are you comfortable with Scala?"
> "My production Spark is in PySpark, but the DataFrame API is the same engine and nearly the same
> code — `withColumn`, `groupBy`, window functions, `MERGE`. I can read Scala Spark and write
> transformations in it; the differences are mostly syntax like `===` for column equality and `val`
> immutability. For a Scala-heavy codebase I'd ramp within a couple of weeks, and the conceptual
> Spark knowledge — shuffles, partitioning, joins, skew, Catalyst — carries over completely."

---

## 7.4 Airflow — demand 112×

### The mental model
Airflow is **orchestration as Python code**: you define a **DAG** of tasks with dependencies; the
scheduler runs them on a schedule, handles retries, backfills, and alerting. It does **not** move data
itself — it triggers Spark/SQL/containers and tracks state. (Your ADF/Databricks Workflows experience is
the same paradigm.)

### Core concepts (vocabulary)
- **DAG** = the workflow (Python file) with a `schedule`, `start_date`, dependencies (`a >> b`).
- **Task / Operator** = unit of work: `PythonOperator`, `BashOperator`, `SQLExecuteQueryOperator`,
  `SparkSubmitOperator`, `DatabricksRunNowOperator`, **TaskFlow** `@task` decorator (modern).
- **Sensor** = waits for a condition (file/partition/external task); prefer **deferrable** sensors.
- **logical/execution date & data interval** = the window a run represents — central to **backfills**
  and idempotent reruns.
- **XCom** = pass small values between tasks (pass paths, not big data).
- **Retries + `retry_delay`** (exponential backoff), **SLAs**, **pools** (concurrency limits),
  **catchup** (auto-backfill on/off), **trigger rules** (`all_success`, `one_failed`, …).
- **Connections/Variables** = managed config/secrets (back with a secrets backend, not plaintext).
- **Idempotent tasks** so retries/backfills are safe (same principle you already apply).

### Minimal modern DAG (be able to read/explain this)
```python
from airflow.decorators import dag, task
from datetime import datetime

@dag(schedule="0 2 * * *", start_date=datetime(2025, 1, 1),
     catchup=False, default_args={"retries": 3})
def daily_sales():
    @task
    def extract() -> str:
        return "/lake/bronze/sales/2025-01-01"   # returns a pointer via XCom

    @task
    def transform(path: str) -> str:
        # trigger Spark/dbt here; return output location
        return path.replace("bronze", "silver")

    @task
    def load(path: str):
        ...  # MERGE into Gold (idempotent)

    load(transform(extract()))   # dependency graph: extract >> transform >> load

daily_sales()
```

### How to answer "Have you used Airflow?"
> "I've orchestrated production pipelines with ADF, Databricks Workflows, and Azure DevOps — same
> paradigm as Airflow: DAGs of dependent tasks, schedules, retries with backoff, sensors/triggers,
> backfills over a data interval, and idempotent tasks so reruns are safe. I'm comfortable writing
> Airflow DAGs with the TaskFlow API and operators like `DatabricksRunNow` and `SparkSubmit`. Because I
> already design for idempotency and backfills, moving my orchestration to Airflow is a syntax change,
> not a concept change."

---

## Cheat sheet: mapping YOUR experience → the gap tool

| You already do (Azure/Databricks) | Equivalent in the gap tool |
|---|---|
| Bronze → Silver → Gold | dbt `staging → intermediate → marts` |
| Delta `MERGE` / CDF | Snowflake `MERGE` / Streams + Tasks; dbt incremental `unique_key` |
| Data quality scorecards / DLT expectations | dbt `tests` (`unique`, `not_null`, `relationships`) |
| Delta time travel / Z-ORDER | Snowflake Time Travel / clustering keys |
| ADF + Databricks Workflows | Airflow DAGs / operators / sensors |
| PySpark transformations | Scala Spark (same API) / Snowpark |
| Dev/test data copies | Snowflake zero-copy clone |

**Use this table in interviews.** Translating from your strength to their tool proves transferable
mastery far better than claiming hands-on experience you don't have.

➡ Next: [08-system-design.md](08-system-design.md)
