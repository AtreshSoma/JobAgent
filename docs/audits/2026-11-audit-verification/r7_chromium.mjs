const [repo, dir] = process.argv.slice(2);
const { readdirSync } = await import('node:fs');
const { docxToPdfViaChromium, closePdfBrowsers } = await import(repo + '/src/resume/chromiumPdf.js');
const { resumeHtml } = await import(repo + '/src/resume/tailorRunner.js');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.docx'))) {
  const p = `${dir}/${f}`;
  const r = await docxToPdfViaChromium({ docxPath: p, pdfPath: p.replace(/\.docx$/, '.chromium.pdf'), toHtml: (x) => resumeHtml(x, { root: repo }) });
  console.log(f, r.pages, r.exported ? '' : r.reason);
}
await closePdfBrowsers();
