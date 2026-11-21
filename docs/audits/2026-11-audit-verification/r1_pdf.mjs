const repo = process.argv[2]; const docx = process.argv[3];
const { docxToPdfViaChromium, closePdfBrowsers } = await import(repo + '/src/resume/chromiumPdf.js');
const { resumeHtml } = await import(repo + '/src/resume/tailorRunner.js');
const r = await docxToPdfViaChromium({ docxPath: docx, pdfPath: docx.replace(/\.docx$/, '.chromium.pdf'), toHtml: (p) => resumeHtml(p, { root: repo }) });
console.log(JSON.stringify(r)); await closePdfBrowsers();
