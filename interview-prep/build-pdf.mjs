#!/usr/bin/env node
/**
 * build-pdf.mjs — Consolidate the interview-prep course into ONE professional PDF
 * (plus a combined Markdown master document).
 *
 * Pipeline:  Markdown files  ->  HTML (marked)  ->  print-styled HTML  ->  PDF (Playwright Chromium).
 *
 * Fully offline: no network, no external assets. Renders with the Chromium that ships
 * with the project's existing `playwright` dependency. Run from anywhere:
 *
 *     node interview-prep/build-pdf.mjs
 *     PREP_PDF_NAME="Your Name" npm run prep:pdf     # optional name on the cover
 *
 * Outputs (next to this script):
 *     Data-Engineer-Interview-Prep.pdf   — the polished, navigable study PDF
 *     Data-Engineer-Interview-Prep.md    — a single combined Markdown master doc
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF_OUT = join(HERE, 'Data-Engineer-Interview-Prep.pdf');
const MD_OUT = join(HERE, 'Data-Engineer-Interview-Prep.md');

/** Chapters, in reading order. */
const DOCS = [
  { file: 'README.md',                                    num: '00' },
  { file: '01-sql-mastery.md',                            num: '01' },
  { file: '02-python-and-pyspark.md',                     num: '02' },
  { file: '03-spark-databricks-delta.md',                 num: '03' },
  { file: '04-data-modeling-warehousing.md',              num: '04' },
  { file: '05-pipelines-orchestration-streaming.md',      num: '05' },
  { file: '06-azure-fabric-platform.md',                  num: '06' },
  { file: '07-gap-areas-dbt-snowflake-scala-airflow.md',  num: '07' },
  { file: '08-system-design.md',                          num: '08' },
  { file: '09-behavioral-and-star.md',                    num: '09' },
  { file: '10-mock-interviews.md',                        num: '10' },
  { file: '11-gap-analysis-and-pdf-roadmap.md',           num: 'A'  },
];

marked.setOptions({ gfm: true, breaks: false });

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"');

function slugify(s) {
  return (s.toLowerCase().replace(/[^\w\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60)) || 'section';
}

const fileAnchor = {}; // README.md -> first heading id (for cross-link rewriting)
const usedIds = new Set();
function uniqueId(base) {
  let id = base, i = 2;
  while (usedIds.has(id)) id = `${base}-${i++}`;
  usedIds.add(id);
  return id;
}

async function buildDoc(doc) {
  let md = await readFile(join(HERE, doc.file), 'utf8');
  // Strip single-doc navigation arrows ("➡ Next: ...") — meaningless once combined.
  md = md.replace(/^\u27a1.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  let html = marked.parse(md);
  // Expand collapsible mock-answer blocks so the answers actually print.
  html = html.replace(/<details>/g, '<details open>');

  const toc = [];
  const prefix = `m${doc.num}`.toLowerCase();
  let first = null;

  html = html.replace(/<h([1-3])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (_m, lvl, _attrs, inner) => {
    const text = decode(stripTags(inner)).trim();
    const id = uniqueId(`${prefix}-${slugify(text)}`);
    if (!first) first = id;
    if (Number(lvl) <= 2) toc.push({ level: Number(lvl), text, id });
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });

  fileAnchor[doc.file] = first;
  return { ...doc, html, toc, mdClean: md, title: toc[0]?.text || doc.file };
}

function rewriteLinks(html) {
  return html.replace(/href="([^"]+)"/g, (m, href) => {
    const fm = href.match(/^([\w.-]+\.md)(#.*)?$/);
    if (fm && fileAnchor[fm[1]]) return `href="#${fileAnchor[fm[1]]}"`;
    return m;
  });
}

const CSS = `
:root{
  --ink:#1f2933; --muted:#5b6770; --faint:#8a94a0;
  --brand:#2563eb; --brand-dark:#1e40af;
  --line:#e3e8ee; --code-bg:#f6f8fa; --code-border:#e1e6ec;
  --callout-bg:#eef4ff; --callout-ink:#1e3a5f; --th-bg:#f1f5f9;
}
*{ box-sizing:border-box; }
html{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body{ font-family:"Segoe UI",-apple-system,Roboto,Helvetica,Arial,sans-serif;
  color:var(--ink); font-size:10.5pt; line-height:1.5; margin:0; }

/* cover */
.cover{ display:flex; flex-direction:column; align-items:center; justify-content:center;
  min-height:9in; text-align:center; break-after:page; padding:0 0.4in; }
.cover-badge{ width:84px; height:84px; border-radius:20px; background:var(--brand); color:#fff;
  font-weight:800; font-size:38px; display:flex; align-items:center; justify-content:center; margin-bottom:26px; }
.cover-title{ font-size:30pt; line-height:1.12; margin:0 0 12px; font-weight:800; letter-spacing:-.5px; }
.cover-sub{ font-size:13pt; color:var(--brand-dark); font-weight:600; margin:0 0 30px; }
.cover-name{ font-size:15pt; font-weight:700; margin:0; }
.cover-role{ color:var(--muted); font-size:10.5pt; margin:2px 0 0; }
.cover-rule{ width:120px; height:3px; background:var(--brand); border-radius:2px; margin:30px 0; }
.cover-meta{ color:var(--muted); font-size:9.5pt; }
.cover-meta div{ margin:3px 0; }
.cover-foot{ color:var(--faint); font-size:8.5pt; max-width:5in; margin-top:24px; }

/* table of contents */
.toc{ break-after:page; }
.toc-head{ font-size:20pt; font-weight:800; border-bottom:3px solid var(--brand); padding-bottom:8px; margin:0 0 14px; }
.toc ul{ list-style:none; padding:0; margin:0; }
.toc li a{ text-decoration:none; }
.toc-l1{ margin-top:9px; font-weight:700; font-size:10.5pt; }
.toc-l1 a{ color:var(--brand-dark); }
.toc-l2{ margin:1.5px 0 1.5px 0.3in; font-size:9pt; }
.toc-l2 a{ color:var(--muted); }

/* content */
.module{ break-before:page; }
h1{ font-size:20pt; font-weight:800; margin:0 0 6px; padding-bottom:8px;
  border-bottom:3px solid var(--brand); letter-spacing:-.3px; }
h2{ font-size:14pt; color:var(--brand-dark); font-weight:700; margin:20px 0 7px; }
h3{ font-size:11.5pt; font-weight:700; margin:14px 0 5px; }
h1,h2,h3{ break-after:avoid; }
p{ margin:7px 0; }
a{ color:var(--brand); }
strong{ font-weight:700; color:var(--ink); }
ul,ol{ margin:7px 0; padding-left:1.25em; }
li{ margin:3px 0; }
li::marker{ color:var(--brand); }
hr{ border:none; border-top:1px solid var(--line); margin:16px 0; }

/* inline + block code */
code{ font-family:"Cascadia Code","Consolas",Menlo,monospace; font-size:8.6pt;
  background:var(--code-bg); border:1px solid var(--code-border); border-radius:4px; padding:.5px 4px; }
pre{ background:var(--code-bg); border:1px solid var(--code-border); border-left:3px solid var(--brand);
  border-radius:6px; padding:10px 12px; margin:9px 0; break-inside:avoid; position:relative; }
pre code{ background:none; border:none; padding:0; font-size:8.5pt; line-height:1.42;
  white-space:pre-wrap; word-break:break-word; display:block; }
pre:has(code.language-sql)::before,    pre:has(code.language-python)::before,
pre:has(code.language-scala)::before,  pre:has(code.language-yaml)::before{
  position:absolute; top:0; right:0; font-family:"Segoe UI",sans-serif; font-size:6.6pt; font-weight:700;
  letter-spacing:.5px; color:#fff; background:var(--brand); padding:1.5px 7px; border-radius:0 5px 0 6px; }
pre:has(code.language-sql)::before{ content:"SQL"; }
pre:has(code.language-python)::before{ content:"PYTHON"; }
pre:has(code.language-scala)::before{ content:"SCALA"; }
pre:has(code.language-yaml)::before{ content:"YAML"; }

/* blockquote -> callout */
blockquote{ margin:10px 0; padding:9px 14px; background:var(--callout-bg); border-left:4px solid var(--brand);
  border-radius:0 6px 6px 0; color:var(--callout-ink); break-inside:avoid; }
blockquote p{ margin:4px 0; }

/* tables */
table{ width:100%; border-collapse:collapse; margin:11px 0; font-size:8.8pt; }
thead{ display:table-header-group; }
tr{ break-inside:avoid; }
th,td{ border:1px solid var(--line); padding:5px 8px; text-align:left; vertical-align:top; }
th{ background:var(--th-bg); font-weight:700; }
tbody tr:nth-child(even) td{ background:#fafbfc; }

/* collapsible mock answers (forced open) */
details{ margin:9px 0; border:1px solid var(--line); border-radius:6px; overflow:hidden; break-inside:avoid; }
details>summary{ background:var(--th-bg); padding:6px 12px; font-weight:700; font-size:9.5pt;
  color:var(--brand-dark); list-style:none; }
details>summary::before{ content:"\\25be  "; }
details>*:not(summary){ padding-left:12px; padding-right:12px; }

/* checkbox lists */
input[type=checkbox]{ margin-right:6px; }
`;

async function main() {
  const built = [];
  for (const d of DOCS) built.push(await buildDoc(d));
  for (const b of built) b.html = rewriteLinks(b.html);

  // The cover used to carry one person's name, hardcoded, into every build.
  // It is now opt-in: PREP_PDF_NAME="…" or --name="…"; otherwise no name.
  const ownerName = (process.argv.find((a) => a.startsWith('--name='))?.slice(7)
    ?? process.env.PREP_PDF_NAME ?? '').trim();
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // ---- Table of contents (2 levels) ----
  const tocItems = built.flatMap((b) => b.toc)
    .map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`)
    .join('\n');

  // ---- Cover ----
  const cover = `
  <section class="cover">
    <div class="cover-badge">DE</div>
    <div class="cover-title">Data Engineer<br/>Interview Preparation</div>
    <div class="cover-sub">Senior / Lead Data Engineer — Complete Course &amp; Question Bank</div>
    ${ownerName ? `<div class="cover-name">${escapeHtml(ownerName)}</div>` : ''}
    <div class="cover-role">Senior Data Engineer · Azure · Databricks · Delta Lake · Fabric</div>
    <div class="cover-rule"></div>
    <div class="cover-meta">
      <div>11 chapters · SQL · Python/PySpark · Spark/Delta · Modeling · Pipelines · Azure/Fabric · Gap Areas · System Design · Behavioral · Mock Loops</div>
      <div>Compiled ${dateStr}</div>
    </div>
    <div class="cover-foot">Built from analysis of 244 Data Engineer applications. Prepared for interview study use.</div>
  </section>`;

  const tocSection = `
  <section class="toc">
    <div class="toc-head">Table of Contents</div>
    <ul>${tocItems}</ul>
  </section>`;

  const bodySections = built.map((b) => `<section class="module">${b.html}</section>`).join('\n');

  const fullHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
    <title>Data Engineer Interview Preparation</title><style>${CSS}</style></head>
    <body>${cover}${tocSection}${bodySections}</body></html>`;

  // ---- Render to PDF ----
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });

    // Optional visual QA: PREP_PDF_PNG=1 writes a few preview PNGs of key sections.
    if (process.env.PREP_PDF_PNG) {
      try {
        const shots = [
          ['.cover', '_preview-cover.png'],
          ['.toc', '_preview-toc.png'],
          ['.module table', '_preview-table.png'],
          ['.module pre', '_preview-code.png'],
          ['.module blockquote', '_preview-callout.png'],
          ['.module details', '_preview-details.png'],
        ];
        for (const [sel, name] of shots) {
          const el = await page.$(sel);
          if (el) await el.screenshot({ path: join(HERE, name) });
        }
      } catch (e) { console.warn('  (preview screenshots skipped:', e.message, ')'); }
    }

    await page.pdf({
      path: PDF_OUT,
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span style="font-size:1px"></span>',
      footerTemplate:
        '<div style="font-size:8px;width:100%;text-align:center;color:#9aa0a6;'
        + 'font-family:Segoe UI,Arial,sans-serif;">Data Engineer Interview Prep'
        + ' &nbsp;&middot;&nbsp; Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      margin: { top: '0.7in', bottom: '0.75in', left: '0.7in', right: '0.7in' },
    });
  } finally {
    await browser.close();
  }

  // ---- Combined Markdown master ----
  const masterMd = [
    '# Data Engineer Interview Preparation — Master Document',
    '',
    `_Senior / Lead Data Engineer · ${ownerName ? `${ownerName} · ` : ''}Compiled ${dateStr}_`,
    '',
    '## Contents',
    '',
    ...built.map((b, i) => `${i + 1}. ${b.title}`),
    '',
    '---',
    '',
    built.map((b) => b.mdClean).join('\n\n---\n\n'),
    '',
  ].join('\n');
  await writeFile(MD_OUT, masterMd, 'utf8');

  const pages = built.flatMap((b) => b.toc).length;
  console.log('  ✔ PDF :', PDF_OUT);
  console.log('  ✔ MD  :', MD_OUT);
  console.log(`  ✔ ${built.length} chapters, ${pages} TOC entries.`);
}

main().catch((err) => { console.error('Build failed:', err); process.exit(1); });
