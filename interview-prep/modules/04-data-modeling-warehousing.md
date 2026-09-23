# Module 04 — Data Modeling & Warehousing

**Why:** data warehouse (65), lakehouse (51), data lake (47), dimensional modeling (14), star schema
(8), semantic model (26). Modeling rounds are where consulting (Accenture/Capgemini/TCS) and fintech
(Robinhood/SoFi/Instacart) interviews are won or lost. Your Kimball + medallion background is a
strength — make it crisp.

---

## Topics to prepare
- **Kimball vs Inmon vs Data Vault** — philosophies and when each fits.
- **Star vs snowflake schema**; **fact** and **dimension** tables; **grain**.
- **Fact types:** transaction, periodic snapshot, accumulating snapshot; additive / semi-additive /
  non-additive measures; **factless facts**.
- **Dimension types:** conformed, role-playing, degenerate, junk, **SCD Types 0–6**.
- **Surrogate keys** vs natural/business keys; late-arriving dimensions; early-arriving facts.
- **Normalization** (1NF–3NF) vs **denormalization** for analytics.
- **Medallion architecture** (Bronze/Silver/Gold) and how it maps to staging/integration/presentation.
- **Lakehouse vs warehouse vs lake**; OLTP vs OLAP.
- **Semantic / metric layer** (Power BI semantic models, dbt metrics, LookML).
- **Partitioning, clustering, and storage layout** for query performance.

---

## The non-negotiables (be able to draw these on a whiteboard)

### Star schema
- One central **fact** (measures + foreign keys) surrounded by **dimensions** (descriptive attributes).
- Denormalized dims → fewer joins → fast aggregation, simple for BI tools and self-service.

### Grain — declare it FIRST
> "The grain of this fact is **one row per `<event>` at `<level>`** — e.g., one row per order line
> item." Everything (which dims attach, which measures are additive) follows from the grain. Getting
> grain wrong is the #1 modeling mistake.

### Slowly Changing Dimensions (know cold — top FAQ)
| Type | Behavior | Use when |
|---|---|---|
| **Type 0** | Never changes (retain original) | Immutable attributes (birth date, original credit score) |
| **Type 1** | Overwrite, no history | Corrections; history doesn't matter |
| **Type 2** | New row + version (`effective_from/to`, `is_current`, surrogate key) | Need full history (address changes, plan tier) |
| **Type 3** | Add "previous value" column | Limited history (current + prior only) |
| **Type 4** | History table separate from current | Frequently changing attrs split out |
| **Type 6** | 1+2+3 hybrid (`current` + row versioning + prior col) | Need current value *and* point-in-time history |

**Type 2 is the most asked.** Be able to write the `MERGE`:
```sql
-- Close the current row when attributes changed, then insert the new version.
MERGE INTO dim_customer t
USING staged_customer s
  ON t.customer_bk = s.customer_bk AND t.is_current = 1
WHEN MATCHED AND (t.plan_tier <> s.plan_tier OR t.address <> s.address) THEN
  UPDATE SET t.is_current = 0, t.effective_to = s.effective_from
-- a second pass / INSERT then adds the new current row with a fresh surrogate key.
```

---

## Frequently asked questions (rapid)

**Q: Kimball vs Inmon?**
A: **Inmon** = top-down: build a normalized (3NF) enterprise data warehouse first, then derive
dimensional data marts. **Kimball** = bottom-up: build dimensional **star-schema marts** directly,
integrated through **conformed dimensions**. Kimball is faster to value and BI-friendly; Inmon
emphasizes a single integrated source of truth. Most modern lakehouses are effectively Kimball stars
in the Gold layer.

**Q: What is Data Vault and when?**
A: A modeling style (Hubs = business keys, Links = relationships, Satellites = descriptive/temporal
attributes) optimized for auditability, scalability, and many source systems. Common in highly
regulated enterprises; you still build Kimball marts on top for consumption.

**Q: Star vs snowflake schema?**
A: **Star** = denormalized dimensions (one hop, fast, simple). **Snowflake** = normalized dimensions
into sub-dimensions (saves space, more joins, more complex). Prefer star for analytics; snowflake only
when dimensions are huge/shared and storage/consistency matters.

**Q: Surrogate key vs natural key — why surrogate?**
A: A surrogate (system-generated integer/hash) is stable, decouples the warehouse from source-system
key changes, enables **SCD Type 2** versioning (same business key, multiple surrogate rows), and joins
faster than wide composite natural keys.

**Q: Additive vs semi-additive vs non-additive measures?**
A: **Additive** = sum across all dimensions (revenue). **Semi-additive** = sum across some but not time
(account balance, inventory — you average or take last over time). **Non-additive** = ratios/percentages
(must recompute from components, never sum).

**Q: Transaction vs periodic snapshot vs accumulating snapshot fact?**
A: **Transaction** = one row per event (most granular). **Periodic snapshot** = one row per entity per
period (daily balance). **Accumulating snapshot** = one row per process instance, updated as it moves
through milestones (order → ship → deliver), with multiple date FKs.

**Q: What is a conformed dimension?**
A: A dimension (e.g., Date, Customer, Product) shared **consistently** across multiple fact tables/marts
so metrics can be compared and "drilled across." The backbone of Kimball enterprise integration.

**Q: Degenerate and junk dimensions?**
A: **Degenerate** = a dimension key with no attributes that lives in the fact (e.g., order number).
**Junk** = a dimension that collapses several low-cardinality flags/indicators into one small table to
avoid many tiny dimensions.

**Q: How does medallion map to classic warehouse layers?**
A: **Bronze** ≈ raw/landing/staging (as-ingested, append-only). **Silver** ≈ cleansed/conformed
integration layer (deduped, typed, validated, business keys). **Gold** ≈ presentation layer
(star-schema facts/dims, aggregates, semantic models) for BI/ML.

**Q: Lakehouse vs data warehouse vs data lake?**
A: **Lake** = cheap object storage of raw files, schema-on-read, no guarantees. **Warehouse** =
structured, schema-on-write, ACID, fast SQL, but pricey/closed. **Lakehouse** = warehouse capabilities
(ACID, governance, performance via Delta/Iceberg) **on** the lake's open files — one copy of data for
BI + ML.

**Q: OLTP vs OLAP?**
A: **OLTP** = many small read/write transactions, normalized, row-store, low latency (the source
systems). **OLAP** = large analytical scans/aggregations, denormalized/columnar (the warehouse).

**Q: What is a semantic / metric layer and why?**
A: A governed layer that defines business metrics (e.g., "Net Revenue") and relationships **once**, so
every dashboard/tool computes them identically. Examples: Power BI semantic models (your DP-203 /
Fabric work), dbt metrics, LookML. Prevents "every team has a different revenue number."

---

## Mock modeling problems (with answers)

**M1 — "Design a star schema for an e-commerce orders analytics mart."**
> **Grain:** one row per **order line item**.
> **Fact `fct_order_line`:** FKs `date_key`, `customer_key`, `product_key`, `store_key`,
> `promotion_key`; degenerate `order_id`, `line_number`; measures `quantity`, `unit_price`,
> `discount_amount`, `net_amount` (additive), `is_returned` flag.
> **Dimensions:** `dim_date` (conformed, role-playing as order_date/ship_date), `dim_customer`
> (SCD2 for address/segment history), `dim_product` (SCD2 for price/category history), `dim_store`,
> `dim_promotion`.
> **Talk track:** declare grain first; keep measures additive at line grain; use surrogate keys; SCD2
> on customer/product because history matters for cohort and price analysis.

**M2 — "A customer changes their loyalty tier. How do you preserve historical reporting?"**
> Model `dim_customer` as **SCD Type 2**: close the current row (`is_current=0`, set `effective_to`),
> insert a new row with the new tier, fresh surrogate key, `effective_from = change_date`,
> `is_current=1`. Facts join on the surrogate key valid at the event time, so a Q1 order still reflects
> the **Q1 tier**, while current dashboards filter `is_current=1`. If they only ever need current +
> immediately prior, Type 3 is cheaper; if they need current value quickly *and* full history, Type 6.

**M3 — "How would you model an order-fulfillment process with multiple milestones?"**
> **Accumulating snapshot fact**: one row per order, with multiple date FKs (`order_date_key`,
> `pick_date_key`, `ship_date_key`, `deliver_date_key`) and lag measures (`days_to_ship`,
> `days_to_deliver`). The row is **updated** as the order advances. This makes pipeline/SLA analysis
> trivial without joining many transaction facts.

**M4 — "Your BI users complain numbers don't match across dashboards. Root cause + fix?"**
> Usually each dashboard re-implements metric logic differently (different filters, different
> revenue definition, double-counting from join fan-out). Fix: a **single semantic/metric layer**
> (Power BI semantic model / dbt metrics) defining each measure once over conformed dimensions, plus a
> data contract on grain. I did this migrating 25 SSAS models to Fabric semantic models — one governed
> definition, 3× faster queries, and the "which number is right" debates stopped.

➡ Next: [05-pipelines-orchestration-streaming.md](05-pipelines-orchestration-streaming.md)
