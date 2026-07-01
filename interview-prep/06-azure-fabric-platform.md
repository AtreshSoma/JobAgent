# Module 06 — Azure, Synapse, Fabric & Event Hub (Your Differentiator)

**Why:** Azure (119), ADF (30), Synapse (29), Fabric (24), semantic model (26). This is your **edge**
over generic candidates. For Azure Databricks / Microsoft / Capgemini / Quisitive / consulting roles,
fluency here is the differentiator. Goal: explain each service, when to use it, and how they fit
together — backed by your real projects.

---

## Topics to prepare
- **Azure Data Factory (ADF):** pipelines, activities, datasets, linked services, **Integration
  Runtime** (Azure/Self-hosted/SSIS-IR), triggers, **Mapping Data Flows** vs orchestration-only,
  parameterization, ADF vs Synapse pipelines.
- **Azure Synapse Analytics:** dedicated vs **serverless** SQL pools, Spark pools, distribution
  (hash/round-robin/replicated), PolyBase/COPY, external tables.
- **Microsoft Fabric / OneLake:** Lakehouse vs Warehouse items, **shortcuts**, **Direct Lake**,
  Dataflows Gen2, Data Pipelines, semantic models, capacity (F-SKUs).
- **Storage:** ADLS Gen2 (hierarchical namespace), containers/medallion zones, lifecycle, security.
- **Streaming ingestion:** Event Hubs (Kafka endpoint), capture to ADLS.
- **Power BI semantic models:** import vs DirectQuery vs **Direct Lake**, DAX, RLS, aggregations.
- **Governance/security:** Microsoft Entra ID, managed identities, **Key Vault**, Purview lineage,
  Unity Catalog (on Azure Databricks).
- **DevOps:** Azure DevOps pipelines, ARM/Bicep, Databricks Asset Bundles, CI/CD for data.

---

## Service-by-service cheat sheet

### Azure Data Factory (ADF)
- **What:** cloud ETL/ELT **orchestration** — move + transform data across 90+ connectors.
- **Building blocks:** *pipeline* (container of activities), *activity* (Copy, Notebook, Stored Proc,
  Lookup, ForEach, If, Execute Pipeline), *dataset* (shape/location), *linked service* (connection),
  *Integration Runtime* (compute that runs the work).
- **Integration Runtime types:** **Azure IR** (cloud, serverless), **Self-hosted IR** (on-prem/private
  network access), **SSIS IR** (lift-and-shift existing SSIS packages).
- **Mapping Data Flows** = visual, Spark-backed transformations (no-code transform); for heavy
  transforms many teams instead orchestrate **Databricks notebooks** from ADF.
- **Parameterization** + ForEach = metadata-driven pipelines (one pipeline ingests N tables from a
  control table).

### Azure Synapse Analytics
- **Dedicated SQL pool** = provisioned MPP warehouse; data is sharded across 60 distributions. Choose
  **distribution**: HASH (large fact, on the join key), ROUND_ROBIN (staging), REPLICATE (small dims).
- **Serverless SQL pool** = pay-per-query SQL directly over files in the lake (great for exploration /
  logical warehouse, no infra).
- **Spark pool** = managed Spark for transforms/ML.
- **Loading:** `COPY INTO` / PolyBase for high-throughput bulk loads from ADLS.

### Microsoft Fabric / OneLake (the newest, learn the vocabulary)
- **OneLake** = one tenant-wide, Delta-based data lake ("OneDrive for data"); every workload reads/writes
  the same open Delta tables.
- **Shortcuts** = reference data in place (ADLS, S3, another workspace) without copying.
- **Direct Lake** = Power BI reads Delta/Parquet in OneLake **directly** — import-like speed without
  import refresh or DirectQuery round-trips. Big deal for semantic models.
- **Items:** Lakehouse (Spark + files/tables), Warehouse (T-SQL), Data Pipelines (ADF-like), Dataflows
  Gen2 (Power Query), semantic models, Notebooks.
- **Capacity:** F-SKUs (compute units) shared across workloads.

### Power BI semantic models
- **Storage modes:** **Import** (data cached in-memory VertiPaq, fast, needs refresh), **DirectQuery**
  (live queries to source, no copy, slower), **Direct Lake** (Fabric — best of both over OneLake Delta).
- **DAX** measures + **Row-Level Security (RLS)** + aggregation tables for performance.
- This is where your **25 SSAS → Fabric semantic model** migration lives (3× faster, $120K saved).

---

## Frequently asked questions (rapid)

**Q: ADF vs Databricks — when each?**
A: **ADF** for orchestration and connector-rich movement (extract/land, scheduling, control flow).
**Databricks** for heavy, code-first transformation (PySpark/SQL on Delta at scale). Common pattern:
ADF orchestrates and triggers Databricks notebooks for the transform. (Synapse Pipelines ≈ ADF
embedded in Synapse.)

**Q: Synapse dedicated vs serverless SQL pool?**
A: **Dedicated** = provisioned MPP, predictable performance, you pay for reserved compute — for steady
high-concurrency warehouses. **Serverless** = on-demand T-SQL over lake files, pay per TB scanned — for
ad-hoc/exploration and a logical warehouse without managing infra.

**Q: How do you choose a distribution in a Synapse dedicated pool?**
A: **HASH** on a high-cardinality join/aggregation key for big facts (co-locates joins, avoids data
movement); **REPLICATE** for small dimensions (copy to every node); **ROUND_ROBIN** for staging/load
where there's no good key yet.

**Q: What is Direct Lake and why does it matter?**
A: A Fabric storage mode where Power BI reads Delta tables in OneLake **directly** in memory —
eliminating both import-refresh latency and DirectQuery round-trips. You get import-level performance on
near-real-time data with no data duplication.

**Q: Import vs DirectQuery in Power BI?**
A: **Import** caches data in-memory (fastest queries, but stale until refresh, size-limited).
**DirectQuery** queries the source live (always fresh, no size limit, slower, source load). Choose by
freshness vs performance; Direct Lake (Fabric) gives both.

**Q: What is OneLake and how is it different from ADLS?**
A: OneLake is the single, tenant-wide logical lake built on Delta, automatically provisioned with
Fabric — all engines share one copy of open data, with **shortcuts** to avoid copies. ADLS Gen2 is the
underlying general-purpose hierarchical object store; OneLake sits at a higher, governed, Fabric-native
layer.

**Q: Self-hosted Integration Runtime — when?**
A: When ADF must reach data behind a firewall / on-prem / private VNet (e.g., an on-prem SQL Server).
You install the SHIR on a machine with network line-of-sight to the source.

**Q: How do you secure secrets and identities in Azure data pipelines?**
A: **Managed identities** for service-to-service auth (no passwords), secrets in **Key Vault**
referenced by linked services, **Entra ID** RBAC for access, and Unity Catalog / Purview for data
governance and lineage. Never hardcode connection strings.

**Q: How do you do CI/CD for Azure data engineering?**
A: Git-backed ADF/Synapse (publish to adf_publish branch / ARM templates), **Databricks Asset Bundles**
for notebooks+jobs as code, deploy via **Azure DevOps**/GitHub Actions across dev/test/prod with
parameterized linked services and Key Vault per environment. I automated DataOps this way at Microsoft
(Azure DevOps + GitHub Actions + Logic Apps).

---

## Reference architecture you can draw (your actual platform)

```
            ┌─────────────┐   ADF Pipelines / Autoloader   ┌──────────────────────────────┐
 Sources →  │ Event Hub   │ ─────────────────────────────▶ │  Bronze (raw Delta, ADLS)    │
 (APIs,     │ (Kafka API) │   Structured Streaming         └──────────────┬───────────────┘
  files,    └─────────────┘                                                │ PySpark + DLT
  DB CDC)                                                                  ▼
                                                          ┌──────────────────────────────┐
                                                          │  Silver (clean/conformed)    │
                                                          │  dedup, cast, expectations    │
                                                          └──────────────┬───────────────┘
                                                                         │ star schema / aggregates
                                                                         ▼
                                                          ┌──────────────────────────────┐
                                                          │  Gold (facts/dims, semantic)  │
                                                          └──────────────┬───────────────┘
                                                                         │ Direct Lake
                                                                         ▼
                                                   Power BI / Fabric semantic models, ML, KBot (LLM)
   Orchestration: ADF + Databricks Workflows + Azure DevOps/GitHub Actions
   Governance: Unity Catalog / Purview · Secrets: Key Vault · Identity: Entra ID
```

**Practice:** redraw this from memory in 90 seconds and narrate each hop with a metric from your
experience (5 days → 4 hours; 500GB/day; 99.97% SOX reconciliation; $120K saved).

---

## Mock platform questions (with answers)

**A1 — "Migrate an on-prem SQL Server warehouse to Azure. Walk me through it."**
> Assess sources and SLAs first. **Land:** Self-hosted IR in ADF extracts on-prem SQL into **ADLS
> Bronze** (full first, then CDC/incremental). **Transform:** Databricks PySpark builds Silver
> (dedup/cast/validate) and Gold star schema on Delta — re-implementing SSIS logic as code. **Serve:**
> Synapse serverless or Fabric Warehouse for SQL, Power BI semantic models (Direct Lake) for BI.
> **Cutover:** run parallel, reconcile row counts/control totals, then switch. **Govern:** Key Vault,
> managed identities, Unity Catalog/Purview lineage, Azure DevOps CI/CD. This is exactly the 8TB
> on-prem→Synapse pattern I set up at Assurant.

**A2 — "When would you NOT use Microsoft Fabric?"**
> If the org is standardized on Azure Databricks with mature Unity Catalog governance and complex
> code-first Spark/ML, Fabric may duplicate capability. Fabric shines for unified BI-centric analytics
> with Direct Lake and low-ops semantic models; for heavy custom Spark/streaming and multi-cloud,
> Databricks is often the better core, with Fabric/Power BI as the serving layer. I'd choose based on
> existing investment, governance needs, and whether the team is SQL/BI- or code-first.

➡ Next: [07-gap-areas-dbt-snowflake-scala-airflow.md](07-gap-areas-dbt-snowflake-scala-airflow.md)
