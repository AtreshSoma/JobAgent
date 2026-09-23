# Module 02 — Python & PySpark

**Why:** Python appeared in **207/244** roles; PySpark in **54** explicitly (and implied by every
Spark/Databricks role). Expect a Python coding screen *and* PySpark transformation questions.

---

## Part A — Python for Data Engineering

### Topics to prepare
- **Core data structures:** `list`, `dict`, `set`, `tuple`, when each is O(1) vs O(n).
- **Comprehensions & generators:** `yield`, lazy iteration, memory efficiency for big files.
- **Iterators/itertools:** `groupby`, `islice`, `chain`, `batched` (3.12+).
- **`collections`:** `defaultdict`, `Counter`, `deque`, `namedtuple`.
- **Functions:** `*args/**kwargs`, closures, decorators, `functools.lru_cache`, `partial`.
- **Files & formats:** CSV, JSON/NDJSON, Parquet (via `pyarrow`/`pandas`), gzip streaming.
- **Concurrency:** threads vs processes, the **GIL**, `concurrent.futures`, when async helps (I/O).
- **Error handling & retries:** exceptions, context managers (`with`), exponential backoff.
- **Testing/quality:** `pytest`, fixtures, mocking external calls, type hints, `dataclasses`.
- **Pandas basics:** `groupby`, `merge`, `pivot`, vectorization vs `apply`, chunked reads.

### FAQ (rapid)

**Q: What is the GIL and why does it matter for DE?**
A: The Global Interpreter Lock lets only one thread execute Python bytecode at a time. CPU-bound work
doesn't speed up with threads → use **multiprocessing** or push compute to Spark/SQL. **I/O-bound**
work (API calls, file/network) **does** benefit from threads or `asyncio` because the GIL releases
during I/O.

**Q: `list` vs `generator` for a 50GB file?**
A: A generator (`yield` / `for line in file`) streams one record at a time — constant memory. A list
loads everything → OOM. Prefer generators / chunked reads for large data.

**Q: How do you make an API-ingestion job resilient?**
A: Timeouts, retries with **exponential backoff + jitter**, idempotency keys, paginate with cursors,
checkpoint progress, and dead-letter records that fail repeatedly.

**Q: `is` vs `==`?**
A: `==` compares value/equality; `is` compares identity (same object). Use `is` only for `None`/singletons.

**Q: Shallow vs deep copy?**
A: Shallow copies the container but shares nested objects; `copy.deepcopy` clones recursively. Matters
when mutating nested config/records.

**Q: Why type hints + dataclasses in pipelines?**
A: Self-documenting schemas, catch errors with `mypy`/Pylance, and `@dataclass`/Pydantic models give
you validated, structured records instead of loose dicts.

### Python coding problems (with answers)

**P1 — Stream a large NDJSON file and aggregate by key (constant memory).**
```python
import json
from collections import defaultdict

def revenue_by_country(path: str) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    with open(path, "r", encoding="utf-8") as f:
        for line in f:                       # generator: one line at a time
            if not line.strip():
                continue
            rec = json.loads(line)
            totals[rec["country"]] += rec.get("amount", 0.0)
    return dict(totals)
```
Talk track: streaming + `defaultdict` = O(1) memory in file size, O(n) time.

**P2 — Deduplicate records keeping the latest by timestamp.**
```python
def latest_per_key(records: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for r in records:
        k = r["id"]
        if k not in best or r["updated_at"] > best[k]["updated_at"]:
            best[k] = r
    return list(best.values())
```

**P3 — Retry with exponential backoff + jitter (real ingestion need).**
```python
import random, time
from typing import Callable, TypeVar
T = TypeVar("T")

def with_retry(fn: Callable[[], T], retries: int = 5, base: float = 0.5) -> T:
    for attempt in range(retries):
        try:
            return fn()
        except (TimeoutError, ConnectionError) as e:
            if attempt == retries - 1:
                raise
            sleep = base * (2 ** attempt) + random.uniform(0, 0.25)
            time.sleep(sleep)
    raise RuntimeError("unreachable")
```

**P4 — Flatten a nested JSON record into dotted columns.**
```python
def flatten(obj: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in obj.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, prefix=f"{key}."))
        else:
            out[key] = v
    return out
# {"a":{"b":1}} -> {"a.b":1}
```

**P5 — Parallelize independent API pulls (I/O-bound → threads).**
```python
from concurrent.futures import ThreadPoolExecutor, as_completed

def fetch_all(ids: list[str], fetch_one) -> list[dict]:
    out = []
    with ThreadPoolExecutor(max_workers=16) as ex:
        futures = {ex.submit(fetch_one, i): i for i in ids}
        for fut in as_completed(futures):
            out.append(fut.result())
    return out
```
Talk track: threads help here because each task blocks on network I/O (GIL released). CPU-bound → use
`ProcessPoolExecutor` or Spark.

---

## Part B — PySpark

### Topics to prepare
- **DataFrame API:** `select`, `withColumn`, `filter`, `groupBy`/`agg`, `join`, `union`, `when/otherwise`.
- **Functions:** `pyspark.sql.functions as F` — `col`, `lit`, `coalesce`, `to_date`, `date_add`,
  `regexp_replace`, `split`, `explode`, `from_json`, `row_number`, `rank`, `sum().over(Window...)`.
- **Window specs:** `Window.partitionBy().orderBy().rowsBetween(...)`.
- **Schemas:** `StructType`, explicit schema vs `inferSchema`, handling `corrupt_record`.
- **Joins:** shuffle hash, sort-merge, **broadcast** join, skew handling.
- **Partitioning:** `repartition` vs `coalesce`, `partitionBy` on write, `spark.sql.shuffle.partitions`.
- **Performance:** caching/persist, predicate & projection pushdown, AQE, salting, avoiding UDFs.
- **UDFs:** Python UDF vs **pandas UDF (vectorized)** vs native functions (prefer native).
- **Reading/writing:** Parquet/Delta, partition discovery, `mergeSchema`, write modes.

### FAQ (rapid)

**Q: `repartition` vs `coalesce`?**
A: `repartition(n)` does a **full shuffle**, can increase or decrease partitions, balances data.
`coalesce(n)` **only decreases** partitions, avoids a full shuffle by merging — cheaper but can skew.
Use `coalesce` to reduce small output files; `repartition` to fix skew or increase parallelism.

**Q: When does Spark actually run? (lazy evaluation)**
A: Transformations (`select`, `filter`, `join`) are **lazy** — they build a DAG. An **action**
(`count`, `collect`, `write`, `show`) triggers execution. This lets Catalyst optimize the whole plan.

**Q: `groupByKey` vs `reduceByKey` (RDD) / why avoid `groupBy().collect_list` carelessly?**
A: `reduceByKey` combines map-side before shuffle (less data moved); `groupByKey` shuffles everything.
In DataFrames, prefer aggregations that Catalyst can optimize over wide `collect_list` that materializes
big arrays.

**Q: What is a broadcast join and when?**
A: Spark ships a **small** table to every executor, avoiding a shuffle of the big table. Use when one
side fits in memory (default auto-broadcast threshold ~10MB; raise it or hint
`F.broadcast(small_df)`).

**Q: What causes a shuffle?**
A: Wide transformations: `join`, `groupBy`/agg, `distinct`, `repartition`, window functions. Shuffles
write to disk and move data across the network — the usual performance bottleneck.

**Q: How do you handle data skew?**
A: Diagnose with the Spark UI (one task runs forever). Fixes: **salting** the skewed key, enabling
**AQE skew join** (`spark.sql.adaptive.skewJoin.enabled`), broadcasting the small side, or isolating
hot keys.

**Q: Why avoid Python UDFs?**
A: They serialize rows to Python, breaking Catalyst optimization and pushdown (slow). Prefer built-in
`F.*` functions; if you must, use **pandas/vectorized UDFs** (Arrow) which batch rows.

**Q: What is AQE (Adaptive Query Execution)?**
A: Spark 3+ re-optimizes at runtime using actual stats: coalesces shuffle partitions, switches to
broadcast joins, and splits skewed partitions. Generally leave it on.

**Q: `cache()`/`persist()` — when?**
A: When a DataFrame is reused across multiple actions. Caching a once-used DF wastes memory. Unpersist
when done. Know storage levels (MEMORY_AND_DISK is the safe default).

**Q: `partitionBy` on write vs `repartition`?**
A: `df.write.partitionBy("dt")` creates **directory partitions on disk** (for pruning at read).
`repartition` changes **in-memory** partitioning for the current job. Don't partition a column with
huge cardinality (small-files problem).

### PySpark coding problems (with answers)

**S1 — Top order per customer (window dedup).**
```python
from pyspark.sql import functions as F, Window

w = Window.partitionBy("customer_id").orderBy(F.col("order_ts").desc())
latest = (orders
          .withColumn("rn", F.row_number().over(w))
          .filter(F.col("rn") == 1)
          .drop("rn"))
```

**S2 — Medallion Silver cleanup: dedup, type-cast, quality flag.**
```python
from pyspark.sql import functions as F, Window

w = Window.partitionBy("claim_id").orderBy(F.col("ingest_ts").desc())

silver = (bronze
    .withColumn("amount", F.col("amount").cast("decimal(18,2)"))
    .withColumn("service_date", F.to_date("service_date", "yyyy-MM-dd"))
    .withColumn("is_valid",
        (F.col("amount") > 0) & F.col("service_date").isNotNull())
    .withColumn("rn", F.row_number().over(w))
    .filter(F.col("rn") == 1).drop("rn"))

(silver.write.format("delta").mode("overwrite")
       .option("overwriteSchema", "true")
       .saveAsTable("silver.claims"))
```
Talk track: this is the exact Bronze→Silver pattern from my Microsoft/Assurant work — cast, validate,
dedup on the business key by latest ingest, flag quality.

**S3 — Incremental upsert with Delta `MERGE` (CDC / idempotent load).**
```python
from delta.tables import DeltaTable

tgt = DeltaTable.forName(spark, "silver.customer")
(tgt.alias("t")
   .merge(updates.alias("s"), "t.customer_id = s.customer_id")
   .whenMatchedUpdateAll()
   .whenNotMatchedInsertAll()
   .execute())
```
Talk track: `MERGE` makes the load **idempotent** — re-running the same batch doesn't create
duplicates, which is critical for safe retries and backfills.

**S4 — Parse a Kafka/Event Hub JSON payload (streaming-ready).**
```python
from pyspark.sql import functions as F
from pyspark.sql.types import StructType, StructField, StringType, DoubleType, TimestampType

schema = StructType([
    StructField("event_id", StringType()),
    StructField("user_id",  StringType()),
    StructField("amount",   DoubleType()),
    StructField("ts",       TimestampType()),
])

parsed = (raw                                   # raw has a binary/string "value" column
    .select(F.from_json(F.col("value").cast("string"), schema).alias("d"))
    .select("d.*")
    .filter(F.col("event_id").isNotNull()))
```

**S5 — Fix skew with salting on a hot join key.**
```python
from pyspark.sql import functions as F

N = 16
big_salted = big.withColumn("salt", (F.rand() * N).cast("int"))
small_exploded = (small
    .withColumn("salt", F.explode(F.array([F.lit(i) for i in range(N)]))))

joined = big_salted.join(small_exploded,
    on=["join_key", "salt"], how="inner").drop("salt")
```
Talk track: when one key dominates, salting spreads it across N buckets so no single task is
overloaded; the small side is replicated N times to match.

**S6 — Word/line count the DataFrame way (explain lazy vs action).**
```python
from pyspark.sql import functions as F
counts = (df.select(F.explode(F.split(F.col("text"), r"\s+")).alias("word"))
            .filter(F.col("word") != "")
            .groupBy("word").count()
            .orderBy(F.col("count").desc()))
counts.show(20)   # show() is the ACTION that triggers the DAG
```

---

## Pandas ↔ PySpark mental map (say this if asked "you only know pandas?")

| Pandas | PySpark |
|---|---|
| `df[df.x > 0]` | `df.filter(F.col("x") > 0)` |
| `df.assign(y=...)` | `df.withColumn("y", ...)` |
| `df.groupby("k").agg(...)` | `df.groupBy("k").agg(...)` |
| `pd.merge(a,b,on="k")` | `a.join(b, "k")` |
| in-memory, single node | distributed, lazy, cluster |

➡ Next: [03-spark-databricks-delta.md](03-spark-databricks-delta.md)
