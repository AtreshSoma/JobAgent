/**
 * Minimal, dependency-free DOCX text reader.
 *
 * The dashboard needs to SHOW the user what is actually inside their master
 * resume (and to prove an uploaded file is a real, readable Word document
 * before it replaces the one every tailoring run depends on). Both need the
 * document's text, and neither can afford the Python round trip:
 *
 *   - Python + python-docx is optional in this project. Tailoring degrades to
 *     the master resume when it is missing, so the master-resume screen must
 *     keep working without it.
 *   - Spawning a process per preview would make the UI feel broken on a cold
 *     start (~1s), and an upload must be validated inside the request.
 *
 * A .docx is a ZIP whose `word/document.xml` holds the body, so this reads the
 * ZIP central directory directly and inflates that one entry with node:zlib.
 * It is a READER only: nothing here ever writes a DOCX, so the master resume
 * cannot be corrupted by a preview.
 *
 * Deliberate limitations (documented rather than silently wrong):
 *   - Only `word/document.xml` is read. Text living exclusively in headers,
 *     footers, or text boxes is not returned. Résumés put their content in the
 *     body, and this text is used for preview/validation, never for tailoring.
 *   - ZIP64 archives (>4GB, >65535 entries) are rejected. A resume is ~50KB.
 */

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** ZIP comment field is 16 bits, so the EOCD starts within this of the end. */
const EOCD_MAX_SCAN = 65_557;
/** Guard against a corrupt/hostile size field claiming gigabytes. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

class DocxReadError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string}} [options] `code: 'DOCX_TOO_LARGE'` for a
   *   decompression-bomb refusal; always carries statusCode 422 so a route can
   *   answer "the file is wrong" rather than "the server broke"
   */
  constructor(message, { code = 'DOCX_UNREADABLE' } = {}) {
    super(message);
    this.name = 'DocxReadError';
    this.code = code;
    this.statusCode = 422;
  }
}

/** Locate the End Of Central Directory record. */
function findEocd(buf) {
  const start = Math.max(0, buf.length - EOCD_MAX_SCAN);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new DocxReadError('not a valid .docx file (no ZIP directory found)');
}

/**
 * Read one named entry out of a ZIP buffer.
 *
 * @param {Buffer} buf whole archive
 * @param {string} wanted entry name, e.g. "word/document.xml"
 * @returns {Buffer} the inflated bytes
 */
function readZipEntry(buf, wanted) {
  const eocd = findEocd(buf);
  const entries = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || dirOffset === 0xffffffff) {
    throw new DocxReadError('ZIP64 archives are not supported');
  }
  if (dirOffset >= buf.length) throw new DocxReadError('the .docx directory offset is out of range');

  let cursor = dirOffset;
  for (let n = 0; n < entries; n += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new DocxReadError('the .docx directory is corrupt');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (name === wanted) {
      if (compressedSize > MAX_ENTRY_BYTES) {
        throw new DocxReadError('the document body inside the .docx is implausibly large');
      }
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
        throw new DocxReadError('the .docx entry header is corrupt');
      }
      // Sizes come from the CENTRAL directory: the local header may carry
      // zeros when the writer streamed the entry with a data descriptor.
      const localName = buf.readUInt16LE(localOffset + 26);
      const localExtra = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localName + localExtra;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buf.length) throw new DocxReadError('the .docx is truncated');
      const raw = buf.subarray(dataStart, dataEnd);
      if (method === 0) return Buffer.from(raw);
      if (method !== 8) throw new DocxReadError(`unsupported .docx compression method ${method}`);
      try {
        // Bounded: the compressed-size check above says nothing about the
        // INFLATED size, and deflate reaches ~1000:1 — an 8 MB upload (the
        // upload cap) could expand to gigabytes inside this synchronous call
        // and take the dashboard process down with it (a zip bomb).
        return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (err) {
        if (err instanceof RangeError || err?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new DocxReadError('resume too large when decompressed', { code: 'DOCX_TOO_LARGE' });
        }
        throw new DocxReadError('the document body inside the .docx could not be decompressed');
      }
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new DocxReadError(`not a Word document (${wanted} is missing)`);
}

const XML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** Decode the entity forms WordprocessingML actually emits. */
function decodeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/**
 * Turn WordprocessingML into plain paragraph text.
 * @param {string} xml contents of word/document.xml
 * @returns {string[]} paragraphs, in document order (blank ones dropped)
 */
export function paragraphsFromDocumentXml(xml) {
  const body = String(xml)
    // Deleted revisions and instruction text are not part of the document.
    .replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:tab\b[^>]*>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*>/g, '\n')
    // Paragraph and table-cell/row ends are the only real line breaks.
    .replace(/<\/w:(?:p|tc)>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeXml(body)
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Extract the readable text of a .docx.
 *
 * @param {Buffer} buffer the whole file
 * @returns {{ paragraphs: string[], text: string, wordCount: number }}
 * @throws {DocxReadError} when the file is not a readable Word document
 */
export function extractDocxText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN_SIZE) {
    throw new DocxReadError('the file is empty or too small to be a .docx');
  }
  if (!isDocxBuffer(buffer)) {
    throw new DocxReadError('the file is not a .docx (a Word document is a ZIP starting with "PK")');
  }
  const xml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
  const paragraphs = paragraphsFromDocumentXml(xml);
  const text = paragraphs.join('\n');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return { paragraphs, text, wordCount };
}

/**
 * Cheap magic-byte check: every .docx is a ZIP local file header. Used to
 * reject a renamed .pdf/.doc before spending work on it.
 * @param {Buffer} buffer
 */
export function isDocxBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4
    && buffer[0] === 0x50 && buffer[1] === 0x4b // "PK"
    && (buffer[2] === 3 || buffer[2] === 5 || buffer[2] === 7)
    && (buffer[3] === 4 || buffer[3] === 6 || buffer[3] === 8);
}

export { DocxReadError };
