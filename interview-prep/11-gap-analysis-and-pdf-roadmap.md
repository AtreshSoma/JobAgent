# Appendix A — Gap Analysis: What's Missing & How to Make This a Solid Interview-Prep Pack

This appendix does two jobs: (1) an honest **audit of what the current 10 modules do not yet cover**,
ranked by interview risk, and (2) a concrete **roadmap for turning this study material into a
publication-grade, printable interview-prep PDF**. The consolidated PDF you are reading already applies
several of these improvements — they are marked **✅ Done** below.

---

## A.1 Technical coverage gaps (ranked by interview risk)

The course is deliberately Azure/Databricks-centric because that is the candidate's strength. That focus
is correct, but the following topics appear frequently in job descriptions and live loops and are **not
yet covered in depth**. Close them in priority order.

| # | Missing topic | Why it matters in interviews | Suggested home | Priority |
|---|---|---|---|---|
| 1 | **AWS data stack** — Redshift, Glue, EMR, S3, Athena, Kinesis, Lambda, Step Functions | A large share of DE roles are AWS-first; Azure-only answers lose points | New Module 6B | **High** |
| 2 | **GCP data stack** — BigQuery, Dataflow, Dataproc, Pub/Sub, Composer | Common at ad-tech, retail, and Google-adjacent shops | New Module 6C | **High** |
| 3 | **Apache Kafka in depth** — partitions, ISR, exactly-once, Kafka Streams, Connect, schema registry | Demand 43×; course only covers it adjacently via Event Hub | Extend Module 05 | **High** |
| 4 | **Open table formats beyond Delta** — Apache Iceberg & Hudi (hidden partitioning, copy-on-write vs merge-on-read, catalogs) | Iceberg is now asked alongside Delta at senior level | Extend Module 03 | **High** |
| 5 | **Data Structures & Algorithms screen** — arrays, hash maps, two-pointers, heaps, recursion, Big-O | Big-tech phone screens still gate on a non-SQL coding round | New Module 2B | **High** |
| 6 | **Security, privacy & compliance** — PII classification, masking/tokenization, encryption, RBAC/ABAC, GDPR/CCPA/HIPAA/SOX, row/column security | Probed heavily in fintech, health, and government roles | New Module 11 | **High** |
| 7 | **Data quality & observability tooling** — Great Expectations, Soda, Monte Carlo, dbt tests in depth, data contracts | "How do you guarantee quality?" is a near-universal question | Extend Modules 05/08 | Medium |
| 8 | **File formats & serialization** — Parquet/ORC/Avro internals, encoding, compression, schema registry/evolution | Frequent "why Parquet?" and "how does columnar work?" follow-ups | Extend Module 08 | Medium |
| 9 | **Testing & CI/CD for data** — unit/integration tests, data-diff, environment promotion, blue/green, contract tests | Senior signal; shows engineering maturity | New Module 12 | Medium |
| 10 | **Cost & performance / FinOps** — cluster sizing, spot, autoscaling, storage tiering, query/scan cost | Increasingly asked as cloud bills grow | Extend Modules 03/08 | Medium |
| 11 | **Streaming depth** — Flink vs Spark, stateful processing, watermark tuning, end-to-end exactly-once internals | Differentiator for streaming-heavy roles | Extend Module 05 | Medium |
| 12 | **MLOps / feature engineering adjacency** — feature stores, online vs batch features, vector DBs, RAG/agentic | Ties directly to the candidate's KBot/LLM work | New Module 13 | Medium |
| 13 | **Orchestration alternatives** — Dagster, Prefect, Mage, asset-based orchestration | Course covers Airflow only; some shops use Dagster/Prefect | Extend Module 07 | Low |
| 14 | **Behavioral breadth** — 10+ stories, deeper failure/conflict examples, company-specific value maps (Microsoft, Google, Meta) | Amazon-style loops demand 2 stories per principle | Extend Module 09 | Low |
| 15 | **System-design variety** — multi-region, GDPR-delete, schema-registry-driven, capacity-math worksheets | More reps across problem archetypes builds fluency | Extend Module 08 | Low |

---

## A.2 Structural gaps that weaken it as a *document*

These are about the artifact itself rather than the content. The consolidated PDF fixes the items marked
**✅ Done**; the rest are recommended next steps.

- ✅ **Cover page, table of contents, page numbers, and per-chapter page breaks** (added in this PDF).
- ✅ **Consistent styling** for tables, callouts, and monospaced code with language labels.
- ✅ **This gap-analysis appendix, a one-page cheat sheet, and a glossary** (sections A.4–A.6).
- ⬜ **Master Question Bank** — every question from all modules in one place (no answers) for self-testing,
  plus a separate answer key.
- ⬜ **Printable flashcards** (question → answer) and a **spaced-repetition schedule**.
- ⬜ **TOC with printed page numbers, running chapter headers, and an auto-generated index** — requires a
  paged-media engine (see A.3).
- ⬜ **Fillable trackers** — a mock-interview score log and a checkbox-based 4-week calendar.
- ⬜ **Per-company one-pagers** — stack, values, recent news, and likely questions for each target employer.

---

## A.3 How this PDF is built (and how to make it even stronger)

**Current pipeline (reliable, zero network):** the build script reads the README and all modules, converts
Markdown to HTML with `marked`, applies a print stylesheet, and renders to PDF with **Playwright's headless
Chromium** (`page.pdf()`). This produces a clean, professional, fully offline document with a clickable TOC
and footer page numbers.

**Upgrade path for a publication-grade result:**

1. **Add [Paged.js](https://pagedjs.org/)** to the same Playwright pipeline. It resolves
   `target-counter()` so the TOC can show **real page numbers**, adds **running chapter headers**, and can
   generate a back-of-book **index** — the difference between "nice" and "book-quality."
2. **Add syntax highlighting** by vendoring the `highlight.js` browser bundle and running `hljs.highlightAll()`
   inside the page before `page.pdf()`. Code listings gain color without any runtime network dependency.
3. **Embed a licensed font** (e.g., a clean serif for headings + a programming font for code) so the PDF
   looks identical on every machine, independent of installed system fonts.
4. **Generate a Master Question Bank automatically** by scanning the Markdown for question markers
   (`**Q:`, `### M`, `### Round`, `**P`, numbered behavioral prompts) and emitting a deduplicated list.

---

## A.4 One-page cheat sheet (quick reference)

**SQL — the 5 patterns:** Top-N per group (`ROW_NUMBER`), running/cumulative total (`SUM() OVER`),
period-over-period (`LAG`/`LEAD`), gaps & islands (`date − ROW_NUMBER()`), sessionization (gap > threshold →
new session). Prefer `NOT EXISTS` over `NOT IN`; filter in `WHERE` not `HAVING`; keep predicates sargable.

**Python/PySpark:** `repartition` (full shuffle) vs `coalesce` (merge only); **broadcast** the small side;
fix skew with **salting** or **AQE**; make loads idempotent with **`MERGE`**; avoid Python UDFs (use `F.*`
or vectorized/pandas UDFs); generators for big files.

**Spark/Delta:** stage boundary = **shuffle**; sort-merge join default, broadcast when small;
`_delta_log` + optimistic concurrency = **ACID**; `OPTIMIZE` (compaction) + `ZORDER` (data skipping);
`VACUUM` with care; **CDF** for incremental downstream; **MERGE** for idempotent CDC.

**Modeling:** **declare the grain first**; star over snowflake; **SCD Type 2** via close-row + insert
`MERGE`; conformed dimensions; additive / semi-additive / non-additive measures; medallion ≈
staging/integration/presentation.

**Pipelines:** idempotency = `MERGE`/`replaceWhere` + checkpoints; exactly-once = checkpoint + idempotent
sink; **log-based CDC** captures deletes; event-time **windows + watermarks** for streaming; Lambda vs
Kappa.

**Azure:** ADF **orchestrates**, Databricks **transforms**; Synapse dedicated (MPP) vs serverless
(pay-per-scan); **Direct Lake** = import speed on live OneLake Delta; secrets in **Key Vault** + managed
identities.

**Gap-area scripts:** never say a flat "no" — map your strength to their tool (medallion → dbt
staging/marts; Delta MERGE/CDF → Snowflake MERGE/Streams+Tasks; ADF/Workflows → Airflow DAGs; PySpark →
Scala Spark/Snowpark).

**System design:** clarify requirements → estimate scale → 5 stages (ingest/store/process/serve/orchestrate)
→ **cross-cutting** (idempotency, schema evolution, quality, backfills, observability, cost, security,
recovery) → trade-offs.

**Behavioral:** STAR, ~90 seconds, **lead with the metric**, 50% on *your* Actions, always have a follow-up
number ready.

---

## A.5 Glossary of key terms

| Term | One-line definition |
|---|---|
| **ACID** | Atomicity, Consistency, Isolation, Durability — transactional guarantees Delta adds to the lake. |
| **AQE** | Adaptive Query Execution — Spark 3+ runtime re-optimization (coalesce, broadcast, skew split). |
| **CDC** | Change Data Capture — propagate only inserts/updates/deletes from a source. |
| **CDF** | Change Data Feed — Delta's row-level change stream for incremental consumption. |
| **Conformed dimension** | A dimension shared consistently across facts so metrics drill across. |
| **DAG** | Directed Acyclic Graph — the dependency graph of orchestrated tasks. |
| **Grain** | The exact meaning of one fact-table row; declare it before modeling anything. |
| **Idempotency** | Re-running a job produces the same result with no duplicates or corruption. |
| **Medallion** | Bronze/Silver/Gold layering ≈ raw/clean/presentation. |
| **MERGE** | Upsert by key — the basis of idempotent, CDC-safe loads. |
| **Micro-partition** | Snowflake's automatic ~50–500 MB storage unit with min/max pruning metadata. |
| **OLTP / OLAP** | Transactional row-store source systems vs analytical columnar warehouses. |
| **Sargable** | A predicate that can use an index (`col = x`, not `FUNC(col) = x`). |
| **SCD** | Slowly Changing Dimension — strategies (Type 0–6) for handling attribute history. |
| **Shuffle** | Redistributing data across partitions by key — the main Spark cost. |
| **Skew** | Uneven key distribution overloading one task; fix with salting/AQE/broadcast. |
| **Watermark** | "I won't wait for data later than X" — bounds streaming state and late data. |
| **Z-ORDER** | Multi-dimensional clustering that improves Delta data skipping. |

---

## A.6 Suggested next deliverables (in order)

1. **AWS + GCP gap chapters** (Modules 6B/6C) — the single biggest coverage win.
2. **Master Question Bank + answer key** appendix for timed self-testing.
3. **Security & compliance module** (Module 11) — high-frequency, currently thin.
4. **Paged.js upgrade** for printed TOC page numbers, running headers, and an index.
5. **Printable flashcards + mock score tracker** to operationalize the 4-week plan.

You already have the experience and the core modules. Closing these gaps converts "well-prepared on my
stack" into "prepared for any DE loop on the market."
