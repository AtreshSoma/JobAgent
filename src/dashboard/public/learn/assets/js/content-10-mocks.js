/* Module 10 — Mock Interviews */
(function () {
  window.__COURSE = window.__COURSE || { modules: [] };
  window.__COURSE.modules.push({
    id: "mocks",
    title: "Mock Interviews",
    icon: "🎤",
    summary: "Four full timed loops with model answers — Fintech, Big Tech, Platform Vendor, and Consulting.",
    topics: [
      {
        id: "how-to",
        title: "How to Run These Mocks",
        tagline: "Read first",
        search: "mock interview how to timed cover answer record self score rubric",
        blocks: [
          { p: "Each mock simulates a real loop drawn from the company archetypes in your applications. Don't just read — <strong>perform</strong> them." },
          { scenario: { title: "Set the room like the real thing", body: "Pick a quiet hour, open a blank doc as your “whiteboard,” start a timer, and have someone (or a recording) play the interviewer. Answer out loud — typing answers silently builds a false sense of fluency that collapses when you have to speak." } },
          { olist: [
            "Set a timer for each round.",
            "<strong>Cover the model answer</strong> and respond out loud, as if a human is listening.",
            "Record the behavioral rounds and play them back.",
            "Only then reveal the answer and compare.",
            "Score yourself with the rubric below; target consistent 4–5s before real interviews.",
          ] },
          { table: { headers: ["Dimension", "1 (weak)", "5 (strong)"], rows: [
            ["Correctness", "Buggy", "Correct, handles edges"],
            ["Clarity", "Rambling", "Structured, narrates thinking"],
            ["Trade-offs", "One option", "Compares + justifies"],
            ["Seniority signals", "Happy path only", "Idempotency, scale, failure, cost"],
            ["Metrics in stories", "Vague", "Quantified + defensible"],
          ] } },
          { tip: "Do one full mock out loud the day before a real interview — then rest. Cramming new material the night before hurts more than it helps." },
          { analogy: "A mock is a <strong>dress rehearsal</strong>. You don't want opening night to be the first time you wear the costume under the lights — the nerves, the timing, the spoken delivery all need a trial run while the stakes are zero." },
          { tryit: { title: "Your turn", body: "Block 60 minutes today and run Mock 1 fully timed, out loud, answering before you reveal each model answer. Score yourself with the rubric — where did you score below a 4?" } },
          { qa: [
            { q: "Why answer out loud instead of just reading?", a: "Because speaking is the skill being tested. Reading silently builds a false fluency that collapses the moment you must explain a trade-off to a live human. Rehearse the actual muscle." },
            { q: "How should you score yourself honestly?", a: "Use the five-dimension rubric (correctness, clarity, trade-offs, seniority signals, defensible metrics). Record yourself — you'll hear rambling and filler you can't notice in your head." },
            { q: "How often should you mock?", a: "Spread them out: one loop every few days through your prep, then one final full loop the day before — followed by rest, not cramming." },
          ] },
        ],
      },
      {
        id: "mock-fintech",
        title: "Mock 1 — Fintech",
        tagline: "Robinhood / SoFi / Brex style",
        search: "mock fintech sql analytics engineering dbt pipeline behavioral payment fraud",
        blocks: [
          { p: "60-minute loop: SQL → analytics engineering → pipeline design → behavioral. Reveal each answer after you attempt it." },
          { scenario: { title: "The context", body: "You're interviewing for a Senior Data/Analytics Engineer role at a payments-heavy fintech. They live in SQL, dbt, and Snowflake, care deeply about metric trust and PII, and will probe whether you can balance real-time needs against clean reporting. Answer as if money and compliance are on the line — because they are." } },
          { analogy: "This loop is the <strong>'can we trust you with money-grade data?' test</strong>. Fintech reviewers care less about flashy tricks and more about whether your metrics are exact, your PII is protected, and you know when real-time is worth the cost. Answer like an auditor is in the room." },
          { tip: "Timebox it: SQL ~15 min, analytics engineering ~15, design ~20, behavioral ~10. Attempt each fully before revealing the model answer." },
          { qa: [
            { q: "SQL: For each user, find their first successful transaction and the days until their second.", a: ["Filter to successes, rank by time, pivot the first two with conditional aggregation, then diff. Use ROW_NUMBER over (PARTITION BY user_id ORDER BY txn_ts), keep rn ≤ 2, MAX(CASE WHEN rn=1…) and rn=2, then DATEDIFF. Users with only one success return NULL and are filtered out (or kept with a LEFT pattern if asked)."] },
            { q: "Analytics engineering: build a trustworthy daily revenue metric used by 5 teams.", a: ["Define it once in a semantic/metric layer over a conformed fct_revenue at a declared grain. In dbt: staging per source → intermediate → marts/fct_revenue (incremental, unique_key), plus tests (not_null, unique, relationships) and a source-freshness check. CI runs dbt build on PRs. Every team refs the same model — no divergent definitions. Tie to your 25-SSAS→Fabric consolidation."] },
            { q: "Design: ingest payment events for real-time fraud AND daily finance reporting.", a: ["A Lambda/lakehouse problem. Stream events into Kafka; Structured Streaming scores fraud in real time (event-time windows + watermark) and writes raw to Delta Bronze (checkpointed). A batch Silver/Gold job builds the finance star schema daily via idempotent MERGE, reconciling late data. Same Delta tables serve BI. Cross-cutting: idempotency, PII masking (payments!), tests, freshness SLAs, consumer-lag monitoring. Stream only where seconds matter."] },
            { q: "Behavioral: tell me about a time you improved data trust.", a: ["Story F (68% → 94%). 90 seconds, STAR, quantified. Follow-up “how did you measure confidence?” → stakeholder survey + reduced data-dispute tickets + quality/freshness scorecards."] },
          ] },
        ],
      },
      {
        id: "mock-bigtech",
        title: "Mock 2 — Big Tech",
        tagline: "Amazon / Microsoft / Dropbox style",
        search: "mock big tech pyspark sessionization data modeling system design dive deep behavioral",
        blocks: [
          { p: "75-minute loop: PySpark coding → data modeling → system design → behavioral/LP deep-dive." },
          { scenario: { title: "The context", body: "A Big Tech org with massive event volume. They want airtight coding, crisp modeling, a system design that survives scale and failure, and — especially at Amazon — behavioral answers tied to Leadership Principles with relentless “why?” follow-ups. Bring numbers and defend them." } },
          { analogy: "Big Tech loops are a <strong>depth-and-scale stress test</strong>. They assume you can code; what they're really checking is whether your design survives 100M events and failure, and whether your stories hold up under four levels of 'why?'. Shallow answers crack — bring numbers." },
          { tip: "Timebox it: PySpark ~20 min, modeling ~15, system design ~25, behavioral/LP ~15. Narrate your thinking the whole way." },
          { qa: [
            { q: "PySpark: count each user's sessions where a 30-min gap starts a new session.", a: ["Sessionization: Window partitionBy(user_id) orderBy(event_ts); LAG to get prev_ts; flag new_session when gap > 30 min; running SUM of flags = session_id; groupBy user_id, MAX(session_id) = session_count. Note window functions shuffle; each user's data fits a partition unless one mega-user is a hot key."] },
            { q: "Modeling: model a ride-sharing trips warehouse.", a: ["Grain = one completed trip. fct_trip: FKs date/rider/driver/pickup_loc/dropoff_loc/vehicle/promo; degenerate trip_id; measures distance, duration, fare, tip, surge (non-additive — keep components), driver_payout. SCD2 dims for rider/driver tier history; role-playing dim_date (pickup/dropoff). For the request→match→complete lifecycle, an accumulating snapshot with milestone date FKs and lag measures."] },
            { q: "System design: analytics platform for 100M daily events.", a: ["Use the framework. Clarify consumers/freshness/scale. Ingest clickstream via Kafka → Structured Streaming → Delta Bronze; OLTP via CDC; APIs via batch. Medallion transform in Spark/dbt to conformed Gold stars. Serve BI via semantic models, low-latency metrics via an OLAP store. Then spend half the time on cross-cutting: idempotency, schema evolution, DQ + quarantine, partition + OPTIMIZE/Z-ORDER, skew handling, observability, cost, governance. Close with trade-offs and a v2."] },
            { q: "Behavioral (Dive Deep): the hardest performance issue you debugged.", a: ["The 4×-slow Silver job. Expect four levels of why: Spark UI showed one straggler task (skew from a new source's NULL join keys) and a shuffle-size jump. Root cause: hot key + small files in Bronze. Fix: salt the key / enable AQE skew join, OPTIMIZE Bronze, re-broadcast the dim that had grown past the threshold. Know your numbers."] },
          ] },
        ],
      },
      {
        id: "mock-platform",
        title: "Mock 3 — Platform Vendor",
        tagline: "Databricks / MongoDB style",
        search: "mock platform vendor spark internals delta deep dive customer facing communication lakehouse",
        blocks: [
          { p: "60-minute loop: Spark internals rapid-fire → Delta deep dive → customer-facing scenario → communication." },
          { scenario: { title: "The context", body: "You're interviewing at a data-platform vendor (think Databricks or MongoDB) for a role that's part deep engineering, part customer-facing. They'll test how far you can go into Spark/Delta internals AND whether you can explain a lakehouse to a non-technical VP without jargon. Depth and clarity both score." } },
          { analogy: "A platform-vendor loop is the <strong>'expert who can also teach' test</strong>. They push you deep into Spark/Delta internals, then flip and ask you to explain a lakehouse to a non-technical VP. You score on both axes — going deep AND surfacing simply." },
          { tip: "Timebox it: internals rapid-fire ~15 min, Delta deep dive ~15, customer scenario ~20, communication ~10. Switch registers cleanly between expert and explainer." },
          { qa: [
            { q: "Spark internals rapid-fire.", a: ["Stage boundary = a shuffle (wide dependency). Default join for two big tables = sort-merge; broadcast if one is small. AQE = runtime re-optimization (coalesce shuffle partitions, switch to broadcast, split skew). Driver OOM = collect()/toPandas() of large data. Narrow vs wide = no shuffle vs shuffle. Fix skew = salt / AQE skew join / broadcast / isolate hot keys."] },
            { q: "Delta deep dive.", a: ["ACID via the transaction log (_delta_log) of add/remove file actions + optimistic concurrency; readers get a consistent snapshot. OPTIMIZE = compaction; Z-ORDER = multi-dim clustering for data skipping. VACUUM danger = deletes files past retention, breaking time travel/concurrent readers if too low. MERGE = idempotent upsert for CDC. CDF = row-level change feed. Schema enforcement by default, opt-in evolution."] },
            { q: "Customer scenario: their Databricks job is slow and expensive.", a: ["Diagnose before prescribing. Spark UI/query profile: skew (straggler), excessive shuffle, small files in Bronze, spill/GC, oversized all-purpose cluster. Quick wins: enable AQE + Photon, move prod to job clusters with autoscale + auto-terminate, OPTIMIZE/Z-ORDER hot tables, partition/prune, broadcast small dims, cache only reused DataFrames, avoid Python UDFs. Right-size + spot for non-critical. Frame as cost AND performance; confirm with before/after metrics."] },
            { q: "Communication: explain the lakehouse to a VP who only knows warehouses.", a: ["“A warehouse is fast SQL but locks data in a pricey system, and you keep a second copy in a lake for ML. A lakehouse puts warehouse features — ACID, governance, fast SQL — directly on cheap open storage, so you keep one copy that serves both BI and ML, with lower cost and no lock-in.” Analogy-driven, no jargon."] },
          ] },
        ],
      },
      {
        id: "mock-consulting",
        title: "Mock 4 — Consulting / Azure",
        tagline: "Accenture / Capgemini / Quisitive style",
        search: "mock consulting azure screening scenario migration behavioral client facing dp-203",
        blocks: [
          { p: "45-minute loop: screening Q&A → Azure scenario → behavioral. Breadth and client-readiness matter here." },
          { scenario: { title: "The context", body: "A consulting/staffing firm (Accenture, Capgemini, TCS, Quisitive) placing you with an enterprise client. They value breadth across the Azure/GCP stack, ETL fundamentals, and client-readiness — can you walk a stakeholder through a migration calmly? Lead with your DP-203 Azure depth and your real on-prem→Synapse migration." } },
          { analogy: "A consulting loop is a <strong>breadth-and-bedside-manner test</strong>. The client is buying someone who can span the Azure/GCP stack <em>and</em> walk a nervous stakeholder through a migration calmly. Confidence and clear communication score as much as the technical plan." },
          { tip: "Timebox it: screening rapid-fire ~10 min, Azure scenario ~20, behavioral ~15. Lead with your DP-203 depth and a real migration story." },
          { qa: [
            { q: "Screening rapid answers.", a: ["Years in DE: ~8 across finance, healthcare, insurance, pharma. ADF vs Databricks: ADF orchestrates + moves; Databricks transforms at scale; ADF triggers Databricks. Synapse dedicated vs serverless: provisioned MPP vs on-demand SQL over lake files. DP-203: yes. Sponsorship: H-1B transfer. Client-facing: yes — presented platforms, trained 150+ users."] },
            { q: "Scenario: move on-prem SQL Server reporting to Azure with minimal disruption.", a: ["Self-hosted IR in ADF extracts on-prem SQL → ADLS Bronze (full, then CDC). Databricks PySpark builds Silver/Gold Delta star schema (re-implementing SSIS as code). Serve via Synapse serverless / Fabric Warehouse + Power BI semantic models (Direct Lake). Run parallel, reconcile control totals, then cut over. Govern with Key Vault, managed identities, Purview lineage; CI/CD via Azure DevOps. Minimal disruption = parallel run + phased cutover. Tie to your Assurant 8TB on-prem→Synapse migration."] },
            { q: "Behavioral: working with a difficult stakeholder / changing requirements.", a: ["Use the conflict or ambiguity story. Align on the goal, make trade-offs visible with data, deliver an iterative slice, keep the relationship intact."] },
          ] },
        ],
      },
      {
        id: "final-checklist",
        title: "Final-Week Checklist",
        tagline: "Polish & rest",
        search: "final week checklist sql patterns pyspark spark lifecycle star stories gap answers",
        blocks: [
          { p: "In your last week, confirm you can do each of these <strong>cold</strong> — without notes." },
          { list: [
            "Re-do all 5 SQL patterns and the PySpark problems from memory.",
            "Narrate the Spark job lifecycle + Delta ACID without looking.",
            "Draw your reference architecture in 90 seconds.",
            "Deliver all 6 STAR stories in ≤90s each, with numbers.",
            "Give the honest-but-strong answer for each gap: dbt, Snowflake, Scala, Airflow.",
            "Run one full mock out loud the day before — then rest.",
          ] },
          { scenario: { title: "The night before", body: "Don't learn anything new. Re-read your story bank and the gap-area scripts, do a light SQL pattern review, lay out your setup (water, notes, quiet room), and sleep. You've done the work — let it show." } },
          { key: "You have the experience. This academy just makes sure the interviewer sees it. Walk in calm, structured, and quantified. Good luck." },
          { analogy: "Final week is a musician's <strong>last run-through before the recital</strong> — you're not learning new pieces, you're making the ones you know automatic so nerves can't shake them loose." },
          { tryit: { title: "Your turn", body: "Tick each checklist item only when you can do it from memory, out loud, with no notes. Anything you can't is exactly where this week's practice should go." } },
          { qa: [
            { q: "What should you do the night before?", a: "Nothing new. Re-read your story bank and gap-area scripts, do a light SQL pattern skim, prep your physical setup (water, quiet room, notes), and sleep. Rest beats cramming." },
            { q: "What's the single highest-leverage final-week drill?", a: "One full timed mock out loud. It rehearses delivery, timing, and composure together — the things isolated reading can't build." },
          ] },
        ],
      },
    ],
  });
})();
