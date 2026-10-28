/* =====================================================================
   Data Engineer Interview Academy — App engine
   Static, zero-dependency SPA: hash router, content renderer, search,
   progress tracking (localStorage), theming, and code highlighting.
   ===================================================================== */
(function () {
  "use strict";

  // Course modules are registered by the content-*.js files via window.__COURSE.
  const COURSE = window.__COURSE || { modules: [] };
  const MODULES = COURSE.modules;

  // Flatten topics for routing / prev-next / search.
  const FLAT = [];
  MODULES.forEach((m) =>
    (m.topics || []).forEach((t) =>
      FLAT.push({ moduleId: m.id, moduleTitle: m.title, moduleIcon: m.icon, ...t })
    )
  );

  const LS_PROGRESS = "de_academy_progress_v1";
  const LS_THEME = "de_academy_theme_v1";
  const LS_COLLAPSE = "de_academy_collapsed_v1";

  /* ----------------------------- storage ----------------------------- */
  // Writes are guarded too: storage can throw (private windows, blocked site
  // data, a full quota), and an unguarded throw here broke the click handler
  // that called it, so "Mark as complete" silently did nothing.
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not persisted */ } };
  const store = {
    progress() { try { return JSON.parse(localStorage.getItem(LS_PROGRESS)) || {}; } catch { return {}; } },
    setDone(id, done) { const p = store.progress(); if (done) p[id] = 1; else delete p[id]; save(LS_PROGRESS, JSON.stringify(p)); },
    collapsed() { try { return JSON.parse(localStorage.getItem(LS_COLLAPSE)) || {}; } catch { return {}; } },
    setCollapsed(id, v) { const c = store.collapsed(); if (v) c[id] = 1; else delete c[id]; save(LS_COLLAPSE, JSON.stringify(c)); },
  };

  /* ----------------------------- helpers ----------------------------- */
  const $ = (sel) => document.querySelector(sel);
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function topicKey(t) { return `${t.moduleId}/${t.id}`; }
  function findTopic(key) { return FLAT.find((t) => topicKey(t) === key); }
  function moduleById(id) { return MODULES.find((m) => m.id === id); }

  /* ----------------------- course catalog meta ---------------------- */
  // Per-path metadata for the catalog / syllabus experience. Lesson counts
  // and reading time are derived automatically from the content modules.
  const MODULE_META = {
    sql:        { level: "Beginner",     tools: ["SQL", "Window Functions", "CTEs"] },
    python:     { level: "Beginner",     tools: ["Python", "PySpark", "DataFrames"] },
    spark:      { level: "Intermediate", tools: ["Apache Spark", "Databricks", "Delta Lake"] },
    modeling:   { level: "Intermediate", tools: ["Kimball", "Star Schema", "Medallion"] },
    pipelines:  { level: "Intermediate", tools: ["Kafka", "CDC", "Streaming"] },
    azure:      { level: "Intermediate", tools: ["Azure", "ADF", "Synapse", "Fabric"] },
    gaps:       { level: "Advanced",     tools: ["dbt", "Snowflake", "Scala", "Airflow"] },
    design:     { level: "Advanced",     tools: ["Architecture", "Trade-offs"] },
    behavioral: { level: "All levels",   tools: ["STAR", "Amazon LPs"] },
    mocks:      { level: "Advanced",     tools: ["Fintech", "Big Tech", "Consulting"] },
  };
  const LEVEL_CLASS = { "Beginner": "lv-beg", "Intermediate": "lv-int", "Advanced": "lv-adv", "All levels": "lv-all" };
  const TECH_STACK = [
    { i: "🗃️", n: "SQL" }, { i: "🐍", n: "Python" }, { i: "✨", n: "PySpark" }, { i: "⚡", n: "Apache Spark" },
    { i: "🧱", n: "Delta Lake" }, { i: "🔶", n: "Databricks" }, { i: "☁️", n: "Azure" }, { i: "🏭", n: "ADF" },
    { i: "🌐", n: "Synapse" }, { i: "🪟", n: "Fabric" }, { i: "📨", n: "Kafka" }, { i: "🌬️", n: "Airflow" },
    { i: "🔧", n: "dbt" }, { i: "❄️", n: "Snowflake" }, { i: "📊", n: "Power BI" }, { i: "🧮", n: "Scala" },
  ];
  function moduleMinutes(m) { return (m.topics || []).reduce((a, t) => a + readingTime(t), 0); }
  function fmtDuration(min) { if (min < 60) return `${min} min`; const h = Math.floor(min / 60), r = min % 60; return r ? `${h}h ${r}m` : `${h}h`; }
  function levelBadge(level) { return level ? `<span class="level ${LEVEL_CLASS[level] || "lv-all"}">${level}</span>` : ""; }
  function doneCountFor(m) { const p = store.progress(); return (m.topics || []).filter((t) => p[`${m.id}/${t.id}`]).length; }

  /* ---------------------- syntax highlighting ------------------------ */
  const KW = {
    sql: new Set(("SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AS WITH UNION ALL " +
      "DISTINCT CASE WHEN THEN ELSE END AND OR NOT NULL IS IN EXISTS BETWEEN LIKE COUNT SUM AVG MIN MAX OVER PARTITION " +
      "ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE COALESCE NULLIF CAST INSERT UPDATE DELETE MERGE INTO VALUES SET CREATE " +
      "TABLE VIEW WHERE DATEADD DATEDIFF ROWS RANGE UNBOUNDED PRECEDING CURRENT FOLLOWING DESC ASC EXCEPT INTERSECT").split(/\s+/)),
    python: new Set("def class return if elif else for while in is not and or import from as with try except finally raise yield lambda None True False async await pass break continue global nonlocal del assert".split(/\s+/)),
    scala: new Set("val var def object class trait import package new extends with match case if else for while yield return true false null override implicit lazy private protected sealed".split(/\s+/)),
    bash: new Set("npm node run cd ls echo export for do done if then fi git python pip dbt airflow databricks".split(/\s+/)),
    yaml: new Set("name on jobs steps run uses with models tests config materialized".split(/\s+/)),
  };
  function highlight(code, lang) {
    const kw = KW[lang] || KW.sql;
    let out = "", i = 0; const n = code.length;
    const isWord = (c) => /[A-Za-z0-9_]/.test(c);
    while (i < n) {
      const rest = code.slice(i);
      let m;
      if ((m = /^(--[^\n]*|#[^\n]*|\/\/[^\n]*)/.exec(rest))) { out += `<span class="tok-com">${esc(m[0])}</span>`; i += m[0].length; continue; }
      if ((m = /^\/\*[\s\S]*?\*\//.exec(rest))) { out += `<span class="tok-com">${esc(m[0])}</span>`; i += m[0].length; continue; }
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === "`") {
        let j = i + 1; while (j < n && code[j] !== ch) { if (code[j] === "\\") j++; j++; }
        j = Math.min(j + 1, n); out += `<span class="tok-str">${esc(code.slice(i, j))}</span>`; i = j; continue;
      }
      if (/[0-9]/.test(ch)) { let j = i; while (j < n && /[0-9._]/.test(code[j])) j++; out += `<span class="tok-num">${esc(code.slice(i, j))}</span>`; i = j; continue; }
      if (isWord(ch)) {
        let j = i; while (j < n && isWord(code[j])) j++; const w = code.slice(i, j);
        if (kw.has(w) || kw.has(w.toUpperCase())) out += `<span class="tok-kw">${esc(w)}</span>`;
        else out += esc(w);
        i = j; continue;
      }
      out += esc(ch); i++;
    }
    return out;
  }

  /* ------------------------- block renderer -------------------------- */
  function renderBlock(b) {
    if (b.h) return `<h2>${b.h}</h2>`;
    if (b.h3) return `<h3>${b.h3}</h3>`;
    if (b.p) return `<p>${b.p}</p>`;
    if (b.list) return `<ul>${b.list.map((x) => `<li>${x}</li>`).join("")}</ul>`;
    if (b.olist) return `<ol>${b.olist.map((x) => `<li>${x}</li>`).join("")}</ol>`;
    if (b.code) {
      const lang = b.lang || "sql";
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(lang)}</span>` +
        `<button class="copy-btn" data-code="${encodeURIComponent(b.code)}">Copy</button></div>` +
        `<pre><code>${highlight(b.code, lang)}</code></pre></div>`;
    }
    if (b.concept) return callout("concept", "💡 Concept", b.concept);
    if (b.scenario) {
      const title = b.scenario.title ? `<div class="scenario-title">${b.scenario.title}</div>` : "";
      return callout("scenario", "🎯 Scenario / Example", title + (b.scenario.body || b.scenario));
    }
    if (b.analogy) return callout("analogy", "🧠 In Plain English", b.analogy);
    if (b.example) {
      const ex = b.example;
      const title = ex.title ? `<div class="scenario-title">${ex.title}</div>` : "";
      return callout("example", "📘 Worked Example", title + (ex.body || ex));
    }
    if (b.tryit) {
      const ti = b.tryit;
      const title = ti.title ? `<div class="scenario-title">${ti.title}</div>` : "";
      return callout("tryit", "✍️ Try It Yourself", title + (ti.body || ti));
    }
    if (b.steps) return `<ol class="steps">${b.steps.map((x) => `<li>${x}</li>`).join("")}</ol>`;
    if (b.key) return callout("key", "⭐ Key Takeaway", b.key);
    if (b.pitfall) return callout("pitfall", "⚠️ Common Pitfall", b.pitfall);
    if (b.tip) return callout("tip", "🗣️ Interview Tip", b.tip);
    if (b.table) {
      const head = `<thead><tr>${b.table.headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
      const body = `<tbody>${b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
      return `<div class="table-wrap"><table>${head}${body}</table></div>`;
    }
    if (b.qa) return b.qa.map((x) =>
      `<details class="qa"><summary>${x.q}</summary><div class="qa-body">${Array.isArray(x.a) ? x.a.map((p) => `<p>${p}</p>`).join("") : `<p>${x.a}</p>`}</div></details>`
    ).join("");
    return "";
  }
  function callout(kind, label, body) {
    const emoji = label.split(" ")[0];
    const text = label.slice(label.indexOf(" ") + 1);
    return `<div class="callout c-${kind}"><div class="callout-h"><span class="emoji">${emoji}</span>${text}</div>${
      typeof body === "string" && body.trim().startsWith("<") ? body : `<p>${body}</p>`}</div>`;
  }

  /* --------------------------- sidebar ------------------------------- */
  function buildNav(filter) {
    const nav = $("#nav");
    const collapsed = store.collapsed();
    const progress = store.progress();
    const q = (filter || "").trim().toLowerCase();
    let html = "";
    let anyMatch = false;

    MODULES.forEach((m) => {
      const topics = (m.topics || []).filter((t) => {
        if (!q) return true;
        return (t.title + " " + (t.search || "") + " " + m.title).toLowerCase().includes(q);
      });
      if (!topics.length) return;
      anyMatch = true;
      const isCollapsed = q ? false : !!collapsed[m.id];
      html += `<div class="nav-group ${isCollapsed ? "collapsed" : ""}" data-mid="${m.id}">` +
        `<button class="grp-head" data-mid="${m.id}"><span class="grp-ico">${m.icon}</span>` +
        `<span class="grp-name">${m.title}</span><span class="grp-num">${topics.length}</span><span class="chev" title="Expand / collapse">▾</span></button>` +
        `<div class="grp-items">`;
      topics.forEach((t) => {
        const key = `${m.id}/${t.id}`;
        const done = progress[key] ? "done" : "";
        html += `<button class="nav-item" data-key="${key}">` +
          `<span>${t.title}</span>` +
          `<svg class="done-dot ${done}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">${
            done ? '<path d="M20 6 9 17l-5-5"/>' : '<circle cx="12" cy="12" r="9" stroke-width="2" opacity=".3"/>'}</svg>` +
          `</button>`;
      });
      html += `</div></div>`;
    });

    nav.innerHTML = anyMatch ? html : `<div class="empty">No topics match "<b>${esc(filter)}</b>"</div>`;
    nav.querySelectorAll(".grp-head").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        const id = btn.getAttribute("data-mid");
        const grp = btn.parentElement;
        // The chevron toggles collapse; clicking the rest opens the syllabus.
        if (e.target.closest(".chev")) {
          const now = !grp.classList.contains("collapsed");
          grp.classList.toggle("collapsed", now);
          store.setCollapsed(id, now);
          return;
        }
        grp.classList.remove("collapsed");
        store.setCollapsed(id, false);
        location.hash = "#/" + id;
        closeSidebar();
      })
    );
    nav.querySelectorAll(".nav-item").forEach((btn) =>
      btn.addEventListener("click", () => { location.hash = "#/" + btn.getAttribute("data-key"); closeSidebar(); })
    );
    markActive();
  }

  function markActive() {
    const key = currentKey();
    document.querySelectorAll(".nav-item").forEach((b) => {
      const on = b.getAttribute("data-key") === key;
      b.classList.toggle("active", on);
      if (on) { const grp = b.closest(".nav-group"); if (grp) grp.classList.remove("collapsed"); }
    });
    const hash = location.hash.replace(/^#\//, "");
    const isModule = hash && !hash.includes("/");
    document.querySelectorAll(".nav-group").forEach((g) =>
      g.classList.toggle("grp-active", isModule && g.getAttribute("data-mid") === hash));
  }

  function updateProgress() {
    const done = Object.keys(store.progress()).filter((k) => findTopic(k)).length;
    const total = FLAT.length;
    $("#progressBar").style.width = total ? (done / total) * 100 + "%" : "0%";
    $("#progressText").textContent = `${done} of ${total} lessons complete`;
  }

  /* ---------------------------- routing ------------------------------ */
  function currentKey() {
    const h = location.hash.replace(/^#\//, "");
    return h && h !== "home" ? h : "";
  }

  function render() {
    const content = $("#content");
    const hash = location.hash.replace(/^#\//, "");
    if (!hash || hash === "home") { renderHome(content); return; }
    // A bare module id (no "/") opens that path's syllabus / overview page.
    if (!hash.includes("/")) {
      const m = moduleById(hash);
      if (m) { renderModule(content, m); return; }
    }
    const t = findTopic(hash);
    if (!t) { renderHome(content); return; }

    const idx = FLAT.findIndex((x) => topicKey(x) === hash);
    const prev = FLAT[idx - 1], next = FLAT[idx + 1];
    const done = !!store.progress()[hash];
    const body = (t.blocks || []).map(renderBlock).join("");

    $("#crumb").innerHTML = `<span>${t.moduleIcon} ${t.moduleTitle}</span> <span>›</span> <b>${t.title}</b>`;

    content.innerHTML =
      `<article class="page">
        <div class="page-eyebrow">${t.moduleIcon} ${t.moduleTitle}</div>
        <h1>${t.title}</h1>
        <div class="page-meta">
          ${t.tagline ? `<span>${t.tagline}</span>` : ""}
          <span class="chip">⏱ ${readingTime(t)} min read</span>
        </div>
        ${body}
        <div class="complete-bar">
          <button class="btn ${done ? "done" : ""}" id="completeBtn">${done ? "✓ Completed" : "Mark as complete"}</button>
          <span style="color:var(--text-faint);font-size:13px">Track what you've studied, saved in your browser.</span>
        </div>
        <div class="pager">
          ${prev ? `<a href="#/${topicKey(prev)}"><span>← Previous</span><b>${prev.title}</b></a>` : `<a class="disabled"><span>← Previous</span><b>Start</b></a>`}
          ${next ? `<a class="next" href="#/${topicKey(next)}"><span>Next →</span><b>${next.title}</b></a>` : `<a class="next disabled"><span>Next →</span><b>End</b></a>`}
        </div>
      </article>`;

    wireCopy();
    $("#completeBtn").addEventListener("click", () => {
      const nowDone = !store.progress()[hash];
      store.setDone(hash, nowDone);
      updateProgress(); buildNav($("#search").value); render();
    });
    markActive(); updateProgress();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function readingTime(t) {
    const words = (t.blocks || []).reduce((a, b) => a + JSON.stringify(b).split(/\s+/).length, 0);
    return Math.max(2, Math.round(words / 180));
  }

  function renderHome(content) {
    $("#crumb").innerHTML = `<b>Home</b>`;
    const totalTopics = FLAT.length;
    const progress = store.progress();

    const paths = MODULES.filter((m) => m.id !== "intro").map((m) => {
      const meta = MODULE_META[m.id] || {};
      const topics = m.topics || [];
      const done = topics.filter((t) => progress[`${m.id}/${t.id}`]).length;
      const pct = topics.length ? Math.round((done / topics.length) * 100) : 0;
      const tools = (meta.tools || []).slice(0, 3).map((x) => `<span class="tool-chip sm">${x}</span>`).join("");
      // A hash link rather than an inline click handler: the dashboard serves
      // this page under `script-src 'self'`, which refuses inline handlers, so
      // every card was dead. An <a href> navigates with no script involved.
      return `<a class="path-card" href="#/${m.id}">
        <div class="path-top"><div class="ic">${m.icon}</div>${levelBadge(meta.level)}</div>
        <h4>${m.title}</h4>
        <p>${m.summary || ""}</p>
        <div class="path-tools">${tools}</div>
        <div class="path-foot">
          <span class="path-meta">📚 ${topics.length} lessons · ⏱ ${fmtDuration(moduleMinutes(m))}</span>
          <span class="path-cta">View Syllabus →</span>
        </div>
        ${done ? `<div class="path-prog" title="${done}/${topics.length} complete"><span style="width:${pct}%"></span></div>` : ""}
      </a>`;
    }).join("");

    const tech = TECH_STACK.map((t) => `<div class="tech-chip"><span class="tech-ic">${t.i}</span>${t.n}</div>`).join("");

    const features = [
      { i: "💡", t: "Concept", d: "The core idea explained in plain language, no jargon." },
      { i: "🎯", t: "Scenario", d: "A concrete, worked example so the concept actually sticks." },
      { i: "💻", t: "Code", d: "Copy-paste-ready snippets with one-click copy." },
      { i: "⭐", t: "Key Takeaway", d: "The one thing to remember walking into the room." },
      { i: "⚠️", t: "Common Pitfall", d: "The mistakes that quietly fail interviews." },
      { i: "🗣️", t: "Interview Tip", d: "Exactly how to say it out loud, with confidence." },
    ].map((f) => `<div class="feat"><div class="feat-ic">${f.i}</div><h5>${f.t}</h5><p>${f.d}</p></div>`).join("");

    content.innerHTML = `
      <div class="page">
        <section class="hero">
          <div class="eyebrow">Data Engineer Interview Academy</div>
          <h1>Everything you need to land a<br>Senior / Lead Data Engineer offer.</h1>
          <p>A complete, end-to-end course built from <strong>244 real Data Engineer job applications</strong> - every topic explained simply, with a hands-on scenario and interview-ready answers.</p>
          <div class="cta">
            <a class="btn light" href="#/intro/welcome">Start learning free →</a>
            <a class="btn outline" href="#/intro/market">See what's in demand</a>
          </div>
        </section>

        <div class="stat-grid">
          <div class="stat"><div class="n">${MODULES.length - 1}</div><div class="l">Learning paths</div></div>
          <div class="stat"><div class="n">${totalTopics}</div><div class="l">Lessons</div></div>
          <div class="stat"><div class="n">244</div><div class="l">Jobs analyzed</div></div>
          <div class="stat"><div class="n">4</div><div class="l">Full mock loops</div></div>
        </div>

        <h2 class="section-title">Learning paths</h2>
        <p class="section-sub">From SQL foundations to system design, each path is self-contained. Start anywhere and track your progress.</p>
        <div class="path-grid">${paths}</div>

        <section class="tech-sec">
          <h2 class="section-title">Master the tools companies actually use</h2>
          <p class="section-sub">The high-demand data engineering stack, cloud platforms, processing engines, and orchestration.</p>
          <div class="tech-grid">${tech}</div>
        </section>

        <section class="how-sec">
          <h2 class="section-title">How every lesson is structured</h2>
          <p class="section-sub">A consistent rhythm so you study efficiently and remember more under pressure.</p>
          <div class="feat-grid">${features}</div>
        </section>
      </div>`;
    updateProgress();
  }

  function renderModule(content, m) {
    const meta = MODULE_META[m.id] || {};
    const topics = m.topics || [];
    const progress = store.progress();
    const done = doneCountFor(m);
    const first = topics[0];

    $("#crumb").innerHTML = `<a href="#/home">Home</a> <span>›</span> <b>${m.title}</b>`;

    const lessons = topics.map((t, i) => {
      const key = `${m.id}/${t.id}`;
      const isDone = progress[key] ? "done" : "";
      return `<a class="syl-item ${isDone}" href="#/${key}">
        <span class="syl-num">${isDone ? "✓" : (i + 1)}</span>
        <span class="syl-main">
          <span class="syl-title">${t.title}</span>
          ${t.tagline ? `<span class="syl-tag">${t.tagline}</span>` : ""}
        </span>
        <span class="syl-time">⏱ ${readingTime(t)} min</span>
      </a>`;
    }).join("");

    const tools = (meta.tools || []).map((x) => `<span class="tool-chip">${x}</span>`).join("");

    content.innerHTML = `
      <div class="page">
        <section class="mod-hero">
          <div class="mod-hero-ic">${m.icon}</div>
          <div class="mod-hero-body">
            <div class="page-eyebrow">Learning Path</div>
            <h1>${m.title}</h1>
            <div class="page-meta">
              ${levelBadge(meta.level)}
              <span class="chip">📚 ${topics.length} lessons</span>
              <span class="chip">⏱ ${fmtDuration(moduleMinutes(m))} read</span>
              ${done ? `<span class="chip done-chip">✓ ${done}/${topics.length} done</span>` : ""}
            </div>
            <p>${m.summary || ""}</p>
            ${tools ? `<div class="tool-row">${tools}</div>` : ""}
            <div class="cta">
              ${first ? `<a class="btn" href="#/${m.id}/${first.id}">${done ? "Continue path" : "Start path"} →</a>` : ""}
              <a class="btn ghost" href="#/home">← All paths</a>
            </div>
          </div>
        </section>

        <h2 class="section-title">Syllabus</h2>
        <p class="section-sub">${topics.length} lessons · work top-to-bottom or jump to any topic.</p>
        <div class="syllabus">${lessons}</div>
      </div>`;

    markActive();
    updateProgress();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function wireCopy() {
    document.querySelectorAll(".copy-btn").forEach((b) =>
      b.addEventListener("click", () => {
        const code = decodeURIComponent(b.getAttribute("data-code"));
        navigator.clipboard?.writeText(code).then(() => { const o = b.textContent; b.textContent = "Copied!"; setTimeout(() => (b.textContent = o), 1200); });
      })
    );
  }

  /* ----------------------------- chrome ------------------------------ */
  function setTheme(t, persist = true) {
    document.documentElement.setAttribute("data-theme", t);
    if (persist) save(LS_THEME, t);
    $("#themeToggle").textContent = t === "dark" ? "☀️" : "🌙";
    $("#themeToggle").setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  /** A saved choice wins; otherwise follow the operating system's setting. */
  function initialTheme() {
    let saved = null;
    try { saved = localStorage.getItem(LS_THEME); } catch { /* unavailable */ }
    if (saved === "light" || saved === "dark") return { theme: saved, saved: true };
    return { theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", saved: false };
  }
  function openSidebar() { $("#sidebar").classList.add("open"); $("#backdrop").classList.add("show"); }
  function closeSidebar() { $("#sidebar").classList.remove("open"); $("#backdrop").classList.remove("show"); }

  function init() {
    const start = initialTheme();
    setTheme(start.theme, start.saved);
    buildNav("");
    render();

    window.addEventListener("hashchange", () => { render(); markActive(); });
    $("#themeToggle").addEventListener("click", () =>
      setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"));
    $("#hamburger").addEventListener("click", openSidebar);
    $("#backdrop").addEventListener("click", closeSidebar);

    let searchT;
    $("#search").addEventListener("input", (e) => { clearTimeout(searchT); searchT = setTimeout(() => buildNav(e.target.value), 120); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== $("#search")) { e.preventDefault(); $("#search").focus(); }
      if (e.key === "Escape") { $("#search").value = ""; buildNav(""); closeSidebar(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
