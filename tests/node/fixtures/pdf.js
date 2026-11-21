/**
 * Build a small, valid PDF in memory: Helvetica text placed at given points on
 * Letter-size pages. Enough to drive the real PDF reader (pdf.js via unpdf)
 * end to end without checking binary fixtures into the repo.
 *
 * @param {Array<Array<{ text: string, x: number, y: number, size?: number }>>} pages
 *   one array of text pieces per page; y counts up from the bottom (792 = top)
 * @param {{ link?: string }} [options] a URI link annotation on page 1 (e.g. "mailto:…")
 * @returns {Buffer}
 */
export function makePdf(pages, { link = '' } = {}) {
  const escape = (t) => String(t).replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = []; // index i holds object number i + 1
  const add = (body) => { objects.push(body); return objects.length; };

  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pagesId = add(''); // filled in once the kids are known
  const kids = [];
  pages.forEach((pieces, index) => {
    const stream = pieces
      .map(({ text, x, y, size = 10.5 }) => `BT /F1 ${size} Tf ${x} ${y} Td (${escape(text)}) Tj ET`)
      .join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const annots = link && index === 0
      ? ` /Annots [${add(`<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /Border [0 0 0] /A << /S /URI /URI (${escape(link)}) >> >>`)} 0 R]`
      : '';
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >>${annots} >>`));
  });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Lay lines out top-down the way a word processor would: one line every
 * `leading` points from `top`, each at its own x. A line given as a string
 * sits at the left margin.
 *
 * @param {Array<string | { text: string, x?: number, size?: number, gap?: number }>} lines
 *   `gap` adds extra space ABOVE that line (a paragraph break)
 */
export function flowLines(lines, { top = 740, left = 54, leading = 14 } = {}) {
  let y = top;
  return lines.map((line, i) => {
    const piece = typeof line === 'string' ? { text: line } : line;
    if (i > 0) y -= leading + (piece.gap ?? 0);
    return { text: piece.text, x: piece.x ?? left, y, size: piece.size ?? 10.5 };
  });
}
