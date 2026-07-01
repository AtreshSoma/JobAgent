#!/usr/bin/env node
/**
 * Interview Prep Academy — local static server.
 *
 * A tiny, zero-dependency node:http server that serves the study site in
 * ./site. Mirrors the dashboard's safety posture: binds to 127.0.0.1 ONLY,
 * never the network. Run it with:  npm run learn
 *
 * The site is fully static (no API), so you can also just open
 * interview-prep/site/index.html directly in a browser — this server only
 * adds a clean http:// origin and auto-opens your browser.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'site');
const PORT = Number(process.env.LEARN_PORT) || 4747;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';

    // Resolve safely inside ROOT — block path traversal.
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        .end('<h1>404</h1><p>Not found. Try <a href="/">the home page</a>.</p>');
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(`Server error: ${err.message}`);
  }
});

// 127.0.0.1 only — this is a local study site, never a public server.
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log('\n  📚  Data Engineer Interview Academy');
  console.log(`  ➜  ${url}`);
  console.log('  ➜  Press Ctrl+C to stop.\n');
  if (!process.env.LEARN_NO_OPEN) openBrowser(url);
});

/** Best-effort open of the default browser; silent if it fails. */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
}
