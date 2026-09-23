# Module 01 — SQL Mastery

**Why this module is #1:** SQL appeared in **231 of your 244** DE applications. Every loop has a live
SQL round. You will be judged on correctness, clarity, and whether you reach for **window functions**
instead of self-joins.

---

## Topics to prepare

- **Joins:** INNER, LEFT/RIGHT/FULL, CROSS, SELF, anti-join (`NOT EXISTS`), semi-join (`EXISTS`).
- **Aggregation:** `GROUP BY`, `HAVING`, `GROUPING SETS`, `ROLLUP`, `CUBE`.
- **Window functions:** `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`/`LEAD`, `SUM() OVER`, `NTILE`,
  `FIRST_VALUE`/`LAST_VALUE`, frames (`ROWS BETWEEN ... AND ...`).
- **CTEs & recursion:** `WITH`, recursive CTEs (hierarchies, date spines).
- **Set operations:** `UNION [ALL]`, `INTERSECT`, `EXCEPT`.
- **NULL logic:** three-valued logic, `COALESCE`, `NULLIF`, `IS [NOT] DISTINCT FROM`.
- **Date/time:** truncation, date diffs, generating date spines, sessionization.
- **Performance:** indexes, sargability, predicate/projection pushdown, partition pruning,
  `EXPLAIN`/query plans, avoiding `SELECT *`, why `WHERE` beats `HAVING` for row filters.
- **Correctness traps:** `COUNT(col)` vs `COUNT(*)`, join fan-out (row explosion), `NOT IN` + NULLs.

---

## The 5 patterns interviewers reward

> Memorize these until you can write them without thinking. ~70% of SQL interview questions are one of
> these five in disguise.

### Pattern 1 — Top-N per group (deduplication)
"Most recent order per customer", "top 3 products per category", "latest record per key".
```sql
WITH ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_ts DESC) AS rn
  FROM orders
)
SELECT * FROM ranked WHERE rn = 1;          -- rn <= 3 for top-3
```
- `ROW_NUMBER` = exactly one per group (arbitrary tie-break).
- `RANK` = ties share a rank, gaps after (1,1,3).
- `DENSE_RANK` = ties share a rank, no gaps (1,1,2). Use for "top 3 distinct salaries".

### Pattern 2 — Running / cumulative totals & moving averages
```sql
SELECT
  account_id, txn_date, amount,
  SUM(amount) OVER (PARTITION BY account_id ORDER BY txn_date
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance,
  AVG(amount) OVER (PARTITION BY account_id ORDER BY txn_date
                    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS moving_avg_7
FROM transactions;
```
- Default frame with `ORDER BY` is `RANGE UNBOUNDED PRECEDING ... CURRENT ROW` — explicitly use
  `ROWS` to avoid surprises with duplicate sort keys.

### Pattern 3 — Period-over-period change (`LAG`/`LEAD`)
"Month-over-month growth", "churned-then-returned", "compare to previous row".
```sql
SELECT
  month,
  revenue,
  LAG(revenue) OVER (ORDER BY month) AS prev_revenue,
  revenue - LAG(revenue) OVER (ORDER BY month) AS mom_change,
  ROUND(100.0 * (revenue - LAG(revenue) OVER (ORDER BY month))
        / NULLIF(LAG(revenue) OVER (ORDER BY month), 0), 2) AS mom_pct
FROM monthly_revenue;
```

### Pattern 4 — Gaps & islands (consecutive runs)
"Longest streak of active days", "consecutive logins", "contiguous ranges".
```sql
WITH marked AS (
  SELECT user_id, activity_date,
         DATEADD(day,
           -ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY activity_date),
           activity_date) AS grp           -- constant within a consecutive run
  FROM activity
)
SELECT user_id, MIN(activity_date) AS streak_start,
       MAX(activity_date) AS streak_end, COUNT(*) AS streak_len
FROM marked
GROUP BY user_id, grp;
```
Key insight: `date - row_number()` is **constant** across consecutive dates, so it becomes the group key.

### Pattern 5 — Sessionization (event gap > threshold = new session)
```sql
WITH lagged AS (
  SELECT user_id, event_ts,
         LAG(event_ts) OVER (PARTITION BY user_id ORDER BY event_ts) AS prev_ts
  FROM events
),
flagged AS (
  SELECT *,
         CASE WHEN prev_ts IS NULL
               OR event_ts > DATEADD(minute, 30, prev_ts)
              THEN 1 ELSE 0 END AS new_session
  FROM lagged
)
SELECT user_id, event_ts,
       SUM(new_session) OVER (PARTITION BY user_id ORDER BY event_ts) AS session_id
FROM flagged;
```

---

## Frequently asked questions (rapid Q&A)

**Q: `WHERE` vs `HAVING`?**
A: `WHERE` filters rows **before** aggregation and can use indexes; `HAVING` filters **after**
`GROUP BY` on aggregate results. Filter raw rows in `WHERE` whenever possible.

**Q: `RANK` vs `DENSE_RANK` vs `ROW_NUMBER`?**
A: `ROW_NUMBER` = unique sequential (no ties). `RANK` = ties tie, then skips (1,1,3). `DENSE_RANK`
= ties tie, no skip (1,1,2).

**Q: `COUNT(*)` vs `COUNT(col)` vs `COUNT(DISTINCT col)`?**
A: `COUNT(*)` counts rows including NULLs. `COUNT(col)` ignores NULLs in `col`. `COUNT(DISTINCT col)`
counts distinct non-NULL values.

**Q: Why is `NOT IN` dangerous?**
A: If the subquery returns any `NULL`, `NOT IN` yields **no rows** (everything becomes UNKNOWN). Use
`NOT EXISTS` (anti-join) instead — it's NULL-safe and usually optimizes better.

**Q: `UNION` vs `UNION ALL`?**
A: `UNION` removes duplicates (extra sort/hash — slower). `UNION ALL` keeps all rows. Use `UNION ALL`
unless you specifically need dedup.

**Q: What makes a predicate "sargable"?**
A: It can use an index. `WHERE col = @x` is sargable; `WHERE FUNC(col) = @x` (e.g.,
`YEAR(date)=2025`) is not — rewrite as a range: `date >= '2025-01-01' AND date < '2026-01-01'`.

**Q: How do you find duplicates?**
A: `GROUP BY key HAVING COUNT(*) > 1`, or `ROW_NUMBER() OVER (PARTITION BY key ORDER BY ...)` and keep
`rn > 1` to delete.

**Q: Logical order of evaluation?**
A: `FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT`. This is why you can't
reference a `SELECT` alias in `WHERE` but can in `ORDER BY`.

**Q: How do you handle join fan-out (row explosion)?**
A: A 1-to-many join multiplies rows and inflates `SUM`. Pre-aggregate the "many" side in a CTE to the
join grain **before** joining, or aggregate with `COUNT(DISTINCT)`.

**Q: Difference between a correlated and non-correlated subquery?**
A: A correlated subquery references the outer query and runs per outer row (logically); a
non-correlated one runs once. Optimizers often rewrite both to joins.

**Q: How do you generate a date spine with no gaps?**
A: Recursive CTE or a numbers/calendar table, then `LEFT JOIN` your data so missing days show `0`.

---

## Mock SQL problems (with full answers)

### M1 — Second-highest salary per department (and handle ties)
**Schema:** `employees(emp_id, dept_id, salary)`
**Ask:** Return each department's 2nd-highest **distinct** salary.
```sql
WITH d AS (
  SELECT dept_id, salary,
         DENSE_RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS dr
  FROM employees
)
SELECT dept_id, salary AS second_highest_salary
FROM d
WHERE dr = 2
GROUP BY dept_id, salary;
```
**Why `DENSE_RANK`:** "2nd-highest distinct salary" means ties at the top should not consume rank 2.
Follow-up if asked "what if a dept has < 2 distinct salaries?" → it simply returns no row for that dept;
use a `LEFT JOIN` against `DISTINCT dept_id` if they want NULLs.

### M2 — Customers who bought in Jan but not Feb
**Schema:** `orders(customer_id, order_date)`
```sql
SELECT DISTINCT customer_id
FROM orders j
WHERE order_date >= '2025-01-01' AND order_date < '2025-02-01'
  AND NOT EXISTS (
    SELECT 1 FROM orders f
    WHERE f.customer_id = j.customer_id
      AND f.order_date >= '2025-02-01' AND f.order_date < '2025-03-01'
  );
```
**Talk track:** "I use `NOT EXISTS` rather than `NOT IN` because it's NULL-safe and lets the optimizer
use an anti-join. I also use half-open date ranges `[start, end)` to be index-friendly and avoid
time-component bugs."

### M3 — Median order value per region (no built-in MEDIAN)
```sql
WITH r AS (
  SELECT region, amount,
         ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount) AS rn,
         COUNT(*)    OVER (PARTITION BY region)                  AS cnt
  FROM orders
)
SELECT region, AVG(amount) AS median_amount
FROM r
WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)   -- middle one (odd) or middle two (even)
GROUP BY region;
```
(If the dialect has `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount)`, use that and mention it.)

### M4 — Rolling 7-day active users (dedup then window)
**Schema:** `events(user_id, event_date)`
```sql
WITH daily AS (
  SELECT event_date, COUNT(DISTINCT user_id) AS dau
  FROM events
  GROUP BY event_date
)
SELECT event_date,
       SUM(dau) OVER (ORDER BY event_date
                      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_7d_events
FROM daily;
```
**Trap to call out:** "Note rolling **DISTINCT** users over 7 days isn't a simple window sum because a
user can appear on multiple days. For true 7-day unique users I'd self-join each day to the prior 6 (or
use an approximate distinct like `APPROX_COUNT_DISTINCT` / HyperLogLog at scale)."

### M5 — Funnel conversion: % of users who did A → then B → then C
**Schema:** `events(user_id, step, event_ts)` where step ∈ {'view','cart','purchase'}
```sql
WITH firsts AS (
  SELECT user_id,
         MIN(CASE WHEN step='view'     THEN event_ts END) AS t_view,
         MIN(CASE WHEN step='cart'     THEN event_ts END) AS t_cart,
         MIN(CASE WHEN step='purchase' THEN event_ts END) AS t_buy
  FROM events
  GROUP BY user_id
)
SELECT
  COUNT(*)                                                   AS viewers,
  COUNT(CASE WHEN t_cart > t_view THEN 1 END)                AS added_to_cart,
  COUNT(CASE WHEN t_buy  > t_cart THEN 1 END)                AS purchased,
  ROUND(100.0 * COUNT(CASE WHEN t_buy > t_cart THEN 1 END)
        / NULLIF(COUNT(*),0), 2)                             AS view_to_buy_pct
FROM firsts;
```
**Talk track:** conditional aggregation collapses the event log to one row per user, enforcing
**ordered** steps via timestamp comparison — cleaner and faster than three self-joins.

### M6 — Detect and delete duplicate rows, keep the earliest
```sql
WITH d AS (
  SELECT ctid_or_pk,
         ROW_NUMBER() OVER (PARTITION BY natural_key ORDER BY created_at) AS rn
  FROM staging
)
DELETE FROM staging
WHERE pk IN (SELECT pk FROM d WHERE rn > 1);
```
**Talk track:** partition by the **natural/business key**, order by recency, keep `rn = 1`, delete the
rest. In Spark/Delta you'd express the keep-set with `MERGE` or `dropDuplicates` instead.

### M7 — Longest active streak per user (gaps & islands)
See Pattern 4 above, then:
```sql
WITH marked AS (
  SELECT user_id, activity_date,
         DATEADD(day, -ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY activity_date),
                 activity_date) AS grp
  FROM (SELECT DISTINCT user_id, activity_date FROM activity) a
)
SELECT user_id, MAX(streak_len) AS longest_streak
FROM (
  SELECT user_id, grp, COUNT(*) AS streak_len
  FROM marked GROUP BY user_id, grp
) s
GROUP BY user_id;
```
**Note the `DISTINCT`** — duplicate dates would break the offset trick.

---

## Performance talking points (say these, you'll stand out)

- "I check the **plan** first — is it doing a seek or a scan? Where's the most expensive operator?"
- "I make predicates **sargable** and lean on **partition pruning** / **predicate pushdown** in the lake."
- "I watch for **join fan-out** and pre-aggregate to the right grain before joining."
- "On columnar engines (Synapse, Snowflake, BigQuery, Spark SQL) I minimize scanned columns and rows,
  cluster/partition on common filter keys, and avoid row-by-row UDFs."
- "I prefer set-based logic over cursors/loops; if I see `YEAR(col)=` I rewrite to a range."

➡ Next: [02-python-and-pyspark.md](02-python-and-pyspark.md)
