/**
 * Resume PDFs through headless Chromium (P2-3).
 *
 * The Word (docx2pdf) and LibreOffice converters reproduce the DOCX exactly,
 * but many machines have neither, and then no PDF exists at all. Chromium
 * ships with JobAgent (Playwright), so this path always works: the tailored
 * DOCX is turned into plain, single-column HTML (tailor.py docx_to_html) and
 * printed. Before printing, the rendered page is checked to contain every
 * paragraph of the DOCX, so the PDF never silently drops content.
 *
 *   RESUME_PDF_ENGINE=auto      (default) Word/LibreOffice when they work,
 *                               Chromium when they do not
 *   RESUME_PDF_ENGINE=chromium  always Chromium (consistent, ATS-plain look)
 *   RESUME_PDF_ENGINE=office    never Chromium (the previous behaviour)
 */
import { readFileSync } from 'node:fs';

export function pdfEngine(env = process.env) {
  const value = String(env.RESUME_PDF_ENGINE ?? 'auto').trim().toLowerCase();
  return ['auto', 'chromium', 'office'].includes(value) ? value : 'auto';
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Pages in a PDF Chromium wrote: count its page objects. */
export function countPdfPages(buffer) {
  const text = Buffer.from(buffer).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length || null;
}

/**
 * Print HTML to a PDF file after checking every expected text is rendered.
 * @returns {Promise<{ exported: boolean, pdfPath: string|null, pages: number|null, reason: string }>}
 */
export async function printHtmlToPdf({ html, texts = [], pdfPath, deps = {} }) {
  let chromium = deps.chromium;
  if (!chromium) ({ chromium } = await import('playwright'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return { exported: false, pdfPath: null, pages: null, reason: `Chromium could not start: ${err.message.split('\n')[0]}` };
  }
  try {
    const page = await browser.newPage();
    // Never fetch anything: the HTML is self-contained.
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    // eslint-disable-next-line no-undef -- runs in the page, where document exists
    const rendered = squash(await page.evaluate(() => document.body.innerText));
    const missing = texts.filter((t) => !rendered.includes(squash(t)));
    if (missing.length) {
      return { exported: false, pdfPath: null, pages: null, reason: `the PDF would leave out ${missing.length} paragraph(s); not written` };
    }
    await page.pdf({ path: pdfPath, format: 'Letter', printBackground: false, preferCSSPageSize: true });
    return { exported: true, pdfPath, pages: countPdfPages(readFileSync(pdfPath)), reason: 'ok (Chromium)' };
  } finally {
    await browser.close();
  }
}

/**
 * DOCX -> PDF through Chromium. `toHtml` turns the DOCX into { html, texts }
 * (the tailor's Python `html` mode in production).
 */
export async function docxToPdfViaChromium({ docxPath, pdfPath = docxPath.replace(/\.docx$/i, '.pdf'), toHtml, deps = {} }) {
  let rendering;
  try {
    rendering = await toHtml(docxPath);
  } catch (err) {
    return { exported: false, pdfPath: null, pages: null, reason: `could not read the resume for Chromium: ${err.message}` };
  }
  return printHtmlToPdf({ html: rendering.html, texts: rendering.texts, pdfPath, deps });
}
