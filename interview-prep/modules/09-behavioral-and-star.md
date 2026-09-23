# Module 09 — Behavioral & STAR (Built From Your Real Projects)

**Why:** Every loop ends with behavioral. Amazon makes it ~50% of the decision (Leadership Principles),
and fintech/consulting all probe impact, conflict, and ownership. You have **genuinely strong, quantified
stories** — this module turns your `candidate.json` history into rehearsed answers.

---

## The STAR framework
- **S**ituation — context (1–2 sentences; set the stakes).
- **T**ask — your specific responsibility/goal.
- **A**ction — what **you** did (use "I", show decisions and trade-offs; 50% of the answer).
- **R**esult — quantified outcome + what you learned.

Keep each answer **90 seconds**. Lead with the headline result, then back-fill. Always have a follow-up
metric ready.

---

## Your story bank (memorize these 6 — they cover ~90% of questions)

### Story A — "Impact / biggest accomplishment" → Microsoft medallion pipeline
- **S:** At Microsoft (via Capgemini) on Finance Analytics, executive reporting took **5 days**; analysts
  drowned in ad-hoc data requests.
- **T:** I owned the re-architecture of the reporting data platform.
- **A:** Designed a **Bronze/Silver/Gold medallion** pipeline on **Azure Databricks** with **Delta Live
  Tables** and **structured streaming** from **Event Hub** via ADF; built PySpark transforms for
  **500GB+/day**, with automated quality validation and observability notebooks.
- **R:** Reporting cycle dropped from **5 days → 4 hours**, ad-hoc requests fell **60%**, and data
  freshness went from T+2 to near-real-time. Lesson: declarative pipelines + quality gates beat heroics.

### Story B — "Drove measurable business value" → Conduent Medicaid $8M recovery
- **S:** State Medicaid programs were losing money to improper provider payments across **100M+ claims/yr**.
- **T:** Build BI that surfaced anomalies in mission-critical government reporting (99.9% SLA).
- **A:** Architected SQL Server + SSIS Kimball pipelines and **Tableau anomaly-detection dashboards**;
  optimized partitioning to cut month-end reporting from **18h → 2h**.
- **R:** Recovered **$8M** in improper payments, influenced policy affecting **2M+ beneficiaries**.
  Lesson: data quality has direct dollar and human impact.

### Story C — "Cost savings / technical migration" → 25 SSAS models → Fabric
- **S:** 25 legacy Analysis Services models were slow and expensive to maintain.
- **T:** Modernize the semantic layer.
- **A:** Migrated them to **Microsoft Fabric semantic models** on Synapse, consolidating into a Lakehouse
  and standardizing metric definitions.
- **R:** **3× query performance**, **$120K/yr** infra savings, and consistent numbers across dashboards.
  Lesson: a single governed semantic layer kills "whose number is right" debates.

### Story D — "Ownership / reliability / compliance" → SOX MUAR automation
- **S:** Quarterly SOX MUAR audits reconciling **2M+ monthly transactions** were manual and risky.
- **T:** Automate the DataOps and audit trail.
- **A:** Built end-to-end pipelines with **Azure DevOps, GitHub Actions, and Logic App** automation,
  generating audit trails and reconciliations.
- **R:** **99.97%** reconciliation accuracy, eliminated **$3M** in audit exposure. Lesson: automate the
  controls, not just the data.

### Story E — "Innovation / learning something new" → Mercury KBot (LLM/agentic)
- **S:** 200+ analysts couldn't easily query enterprise finance data.
- **T:** Enable natural-language access without compromising governance.
- **A:** Built **LLM-integrated agentic workflows** with **LangGraph + Copilot Studio** over **Cosmos
  DB**-backed finance data.
- **R:** Self-service NL querying for 200+ analysts. Lesson: I proactively learn emerging tech (RAG,
  agents) and apply it to real data problems.

### Story F — "Trust / stakeholder management" → 68% → 94% confidence
- **S:** Stakeholders distrusted platform data (68% confidence score).
- **T:** Rebuild trust in the data.
- **A:** Pioneered **Medallion-layer quality scorecards**, lineage documentation, and automated audit
  trails so users could see data health and provenance.
- **R:** Confidence rose to **94%**. Lesson: trust is engineered through transparency, not asserted.

---

## 15 behavioral questions with model answers (mapped to your stories)

**1. Tell me about yourself.** → Use the 60-second positioning statement in the
[README](../README.md#7-your-60-second-positioning-statement-memorize).

**2. Most challenging technical problem you solved?**
> Story A. Emphasize the *decisions*: why DLT over hand-built notebooks, how I handled 500GB/day and
> ensured idempotency with MERGE + checkpoints, and how quality gates prevented bad data reaching execs.

**3. A project with measurable business impact?**
> Story B ($8M) or C ($120K). Lead with the number, then the technical "how".

**4. Tell me about a time you dealt with poor data quality.**
> Story F. "I treat data quality as an engineered property — scorecards, expectations, lineage — not a
> hope. Moving 68%→94% confidence came from making data health *visible* and quarantining bad rows."

**5. A time you had to learn a new technology quickly.**
> Story E (LLM/LangGraph) — proves you ramp fast, which directly answers their worry about your **gap
> areas** (dbt/Snowflake/Airflow/Scala).

**6. Tell me about a conflict with a teammate or stakeholder.**
> Pick a real disagreement (e.g., a stakeholder wanting a quick hardcoded fix vs. a maintainable model).
> "I aligned on the goal, showed the maintenance cost of the shortcut with data, proposed a phased
> approach that delivered a quick win *and* the durable solution, and we shipped both. I disagree with
> respect and back it with evidence."

**7. A time you failed or made a mistake.**
> Be honest and show learning. Example shape: "Early on I shipped a pipeline that wasn't idempotent; a
> 2am retry created duplicates in a report. I owned it, fixed it with a MERGE-based load and checkpoints,
> and added a reconciliation check. Now idempotency is the *first* thing I design for." (Never a
> non-failure humblebrag; show real ownership + the systemic fix.)

**8. How do you prioritize when everything is urgent?**
> "I rank by business impact and risk, clarify with stakeholders, and protect critical SLAs first. During
> month-end I sequence so the 99.9% SLA government reports never slip, and defer nice-to-haves." (Story B)

**9. A time you improved performance/efficiency.**
> 18h→2h (Story B) or 5 days→4 hours (Story A). Walk through the *diagnosis* (Spark UI / query plan /
> partitioning) then the fix.

**10. How do you handle ambiguous requirements?**
> "I start with the consumer and the question they're answering, define the grain and SLAs, make
> assumptions explicit, and ship an iterative slice for feedback rather than guessing for months."

**11. A time you influenced without authority.**
> Story C/F — standardizing the semantic layer required convincing multiple teams to adopt one metric
> definition. "I built the case with performance numbers and reduced-maintenance evidence, piloted with
> one team, then let the results sell it."

**12. Tell me about mentoring or leading.**
> If you've guided juniors/contractors: code reviews, pairing on PySpark, establishing the medallion +
> quality standards others now follow. Frame as raising the team's bar.

**13. How do you ensure your pipelines are reliable?**
> Idempotency (MERGE/checkpoints), expectations/tests, monitoring + freshness SLAs, retries with
> backoff, lineage, and on-call runbooks. (Story D)

**14. Why do you want to work here / leave your current role?**
> Tie their mission/stack to your trajectory. Be positive about Microsoft/Capgemini; frame the move as
> wanting bigger scale / ownership / a specific tech direction (e.g., "deepen on streaming/lakehouse at
> product scale"). Never bad-mouth.

**15. Where do you see yourself / how do you grow?**
> "Toward staff/lead data engineering — owning platform architecture and mentoring — while staying
> hands-on. I deliberately keep learning emerging areas like LLM/agentic data apps."

---

## Amazon Leadership Principles (you applied to Amazon — prep these specifically)
Map your stories to the LPs they probe most:

| Leadership Principle | Your story |
|---|---|
| **Customer Obsession** | Story B — recovered $8M; 2M+ beneficiaries served reliably |
| **Ownership** | Story D — owned SOX automation end-to-end; eliminated $3M exposure |
| **Invent and Simplify** | Story A / E — DLT medallion; LLM KBot for self-service |
| **Dive Deep** | Spark UI debugging (Module 03 D2); partitioning 18h→2h |
| **Deliver Results** | 5 days→4 hours; $120K saved; 99.97% accuracy |
| **Bias for Action** | Iterative slice delivery under ambiguity |
| **Earn Trust** | Story F — 68%→94% confidence via transparency |
| **Are Right, A Lot** | Architecture choices that scaled (Delta, medallion) |
| **Learn and Be Curious** | LangGraph/RAG; readiness on dbt/Snowflake/Scala/Airflow |

For Amazon: prepare **2 distinct stories per LP**, all in STAR, all with metrics, and expect deep
"why/what-if" follow-ups ("Dive Deep" means they will drill 4 levels down — know your numbers).

---

## Sponsorship / logistics scripts (you're on H-1B requiring transfer)
Have these ready, calm and factual:
> **"What's your work authorization?"** → "I'm currently on H-1B and would need a standard H-1B
> transfer; I'm authorized to work and have been employed continuously in the US. No cap issues since
> I've been counted. Happy to connect your immigration team with mine to make it smooth."

Know your numbers: target comp (~$150K, negotiable per `candidate.json`), start (~2 weeks), remote/hybrid
preference, and openness to US relocation. Decide your floor before the call so you don't negotiate live.

---

## Smart questions to ask THEM (always have 4–5)
- "What does the data platform look like today, and what's the biggest pain you'd want this role to fix?"
- "Batch, streaming, or both — and what are your freshness SLAs?"
- "How do you handle data quality and on-call for pipelines?"
- "What's the split between building new platform vs. maintaining existing?"
- "How do teams consume the data — BI, ML, reverse-ETL — and who owns the semantic layer?"
- "What does success in the first 6 months look like?"

Asking sharp, design-level questions signals seniority as much as your answers do.

➡ Next: [10-mock-interviews.md](10-mock-interviews.md)
