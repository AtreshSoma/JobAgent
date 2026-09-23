# Data Engineer Interview Prep Course — Atresh Somayajula

A complete, **data-driven** interview preparation course built by analyzing **244 Data Engineer
applications** in your `applications/output/` folder, the job descriptions you applied to, and your
own profile in `config/candidate.json`.

> Goal: walk into Senior / Lead Data Engineer interviews able to (a) **ace the topics you already
> know cold**, and (b) **not freeze** on the gaps the market keeps asking for (Scala, Airflow, dbt,
> Snowflake).

---

## 1. What the market is actually asking you (evidence, not guesswork)

Aggregated keyword frequency across your 244 DE-related application packets. "Matched" = the JD
asked for it **and** you have it. "Missing" = the JD asked for it and your resume did **not** clearly
show it — these are your **interview risk areas**.

| Skill | Demand (×) | You have it? | Priority |
|---|---:|---|---|
| SQL | 231 | ✅ Strong | **Must ace** |
| Python | 207 | ✅ Strong | **Must ace** |
| Spark / PySpark | 149 / 54 | ✅ Strong | **Must ace** |
| ETL / ELT | 159 / 120 | ✅ Strong (vocabulary gap only) | Must ace |
| Data pipelines | 151 | ✅ Strong | Must ace |
| Azure | 119 | ✅ Strong | Differentiator |
| Databricks | 84 | ✅ Strong | Differentiator |
| Streaming | 69 | ✅ Strong (Event Hub, Structured Streaming) | High |
| Data warehouse / lakehouse / lake | 65 / 51 / 47 | ✅ Strong | High |
| Delta Lake | 41 | ✅ Strong | High |
| Kafka | 43 | ⚠️ Adjacent (Event Hub) | Medium |
| Power BI / DAX / semantic models | 44 / 8 / 26 | ✅ Strong | Differentiator |
| Dimensional modeling / star schema | 14 / 8 | ✅ Strong | High |
| **Scala** | **172** | ❌ **Gap** | **Close the gap** |
| **Airflow** | **112** | ❌ **Gap (you use ADF/Workflows)** | **Close the gap** |
| **dbt** | **80** | ❌ **Gap** | **Close the gap** |
| **Snowflake** | many roles | ❌ **Gap** | **Close the gap** |

**Read this twice:** Your *weakest* market signals (Scala 172, Airflow 112, dbt 80) are also the
*most frequently requested* tools you don't have. Module 07 is dedicated to making you conversant —
not expert — in all four, plus exactly how to answer "Have you used X?" honestly and strongly.

---

## 2. The roles you're interviewing for (and how they interview)

From your applications, you face **four archetypes**, each with a different interview style:

| Archetype | Examples from your applications | Interview emphasis |
|---|---|---|
| **Big Tech** | Amazon, Microsoft, Dropbox, Reddit, Roblox, Samsara | SQL + Python/Spark coding, data modeling, **system design**, behavioral (Amazon = LPs) |
| **Fintech / high-growth** | Robinhood, SoFi, Brex, Gusto, Instacart, Twilio | SQL + dbt/Snowflake/Airflow, analytics engineering, data quality, stakeholder stories |
| **Data platform vendors** | Databricks, MongoDB | Deep Spark/Delta/lakehouse internals, architecture, customer-facing communication |
| **Consulting / staffing** | Accenture, Capgemini, TCS, Cognizant, Deloitte, Neon IT | Breadth across Azure/GCP, ETL fundamentals, client scenarios, screening Q&A |

---

## 3. The 5 interview rounds you should prepare for

1. **Recruiter / phone screen** — résumé walkthrough, "tell me about yourself", logistics
   (sponsorship, comp, location). → Module 09.
2. **Technical screen — SQL + coding** — live SQL, Python/PySpark, maybe a take-home.
   → Modules 01, 02.
3. **Data modeling & pipeline deep-dive** — dimensional modeling, medallion, Delta, orchestration.
   → Modules 03, 04, 05, 06.
4. **System design** — "Design X data platform / pipeline." → Module 08.
5. **Behavioral / values** — leadership, conflict, impact, failure (Amazon LPs, etc.). → Module 09.

---

## 4. Course map

| Module | File | Covers |
|---|---|---|
| 00 | this `README.md` | Overview, study plan, requirements analysis |
| 01 | [01-sql-mastery.md](modules/01-sql-mastery.md) | SQL theory, patterns, 20+ Q&A, coding problems w/ answers |
| 02 | [02-python-and-pyspark.md](modules/02-python-and-pyspark.md) | Python for DE, PySpark API, coding problems |
| 03 | [03-spark-databricks-delta.md](modules/03-spark-databricks-delta.md) | Spark internals, Databricks, Delta Lake |
| 04 | [04-data-modeling-warehousing.md](modules/04-data-modeling-warehousing.md) | Kimball/Inmon, SCDs, medallion, lakehouse |
| 05 | [05-pipelines-orchestration-streaming.md](modules/05-pipelines-orchestration-streaming.md) | ETL/ELT, Airflow, CDC, Kafka, Structured Streaming |
| 06 | [06-azure-fabric-platform.md](modules/06-azure-fabric-platform.md) | ADF, Synapse, Fabric, Event Hub (your differentiator) |
| 07 | [07-gap-areas-dbt-snowflake-scala-airflow.md](modules/07-gap-areas-dbt-snowflake-scala-airflow.md) | Crash courses on your 4 gaps + how to answer honestly |
| 08 | [08-system-design.md](modules/08-system-design.md) | Framework + 6 worked DE system-design problems |
| 09 | [09-behavioral-and-star.md](modules/09-behavioral-and-star.md) | STAR stories from YOUR projects, LPs, questions to ask |
| 10 | [10-mock-interviews.md](modules/10-mock-interviews.md) | 4 full timed mock loops with model answers |

---

## 5. A 4-week study plan (≈10 hrs/week)

### Week 1 — Coding foundations (the filters)
- **Days 1–2:** Module 01 SQL — work every problem on paper, then verify. Re-do the 5 patterns until automatic.
- **Days 3–4:** Module 02 Python/PySpark — implement each problem yourself before reading the answer.
- **Day 5:** Module 03 Spark internals — shuffles, partitioning, joins, skew, AQE, Delta log.
- **Weekend:** Mock #1 in [10-mock-interviews.md](modules/10-mock-interviews.md) (timed).

### Week 2 — Modeling, pipelines, your platform
- **Days 1–2:** Module 04 — SCDs, grain, star vs snowflake, medallion. Draw schemas by hand.
- **Days 3–4:** Module 05 — batch vs streaming, idempotency, CDC, exactly-once, backfills.
- **Day 5:** Module 06 — rehearse your Azure/Fabric stories out loud (this is your edge).
- **Weekend:** Mock #2 (system design focus).

### Week 3 — Close the gaps
- **Days 1–2:** Module 07 dbt + Snowflake crash courses. Build the mental model; memorize vocabulary.
- **Day 3:** Module 07 Airflow + Scala. Be able to read code and explain concepts.
- **Days 4–5:** Module 08 system design — do 3 problems end-to-end, out loud, with a whiteboard.
- **Weekend:** Mock #3 (gap-area + system design).

### Week 4 — Behavioral + polish
- **Days 1–2:** Module 09 — write and rehearse 10 STAR stories from your real projects.
- **Day 3:** Re-drill every "FAQ" list across modules; flag anything still shaky.
- **Days 4–5:** Re-do all 5 SQL patterns and 5 PySpark patterns cold.
- **Weekend:** Mock #4 (full loop) + review.

---

## 6. How to use each module

Every module follows the same structure so you can drill efficiently:

1. **Topics to prepare** — the checklist of what you must know.
2. **Frequently asked questions (FAQ)** — short Q&A, the "do you know the term" filter.
3. **Patterns** — the reusable templates interviewers reward.
4. **Mock / coding questions** — interview-level problems **with full answers**.

Study rule: **cover the answer, attempt it, then compare.** Passive reading does not survive contact
with a live interviewer.

---

## 7. Your 60-second positioning statement (memorize)

> "I'm a Senior Data Engineer with ~8 years building cloud analytics platforms, currently at Microsoft
> through Capgemini on the Finance Analytics & AI platform. I specialize in the Azure data stack —
> Databricks, Delta Lake, ADF, Synapse, and Microsoft Fabric — designing medallion lakehouse
> architectures in PySpark and SQL. Recently I cut an executive reporting cycle from 5 days to 4 hours
> with a Bronze/Silver/Gold pipeline, migrated 25 legacy SSAS models to Fabric semantic models saving
> $120K a year, and built LLM-powered agentic workflows over our finance data. Before Microsoft I
> worked across healthcare, insurance, and pharma — including a Medicaid claims platform where
> anomaly-detection dashboards recovered $8M in improper payments. I'm DP-203 certified and I love
> turning messy data into systems people trust."

Tighten it, time it to 60 seconds, and make every number ready to defend with a follow-up story
(see Module 09).
