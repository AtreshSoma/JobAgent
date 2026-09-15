#!/usr/bin/env node
/**
 * Interview Prep Academy — local static server.
 *
 * A tiny, zero-dependency node:http server that serves the study site. Mirrors
 * the dashboard's safety posture: binds to 127.0.0.1 ONLY, never the network.
 * Run it with:  npm run learn
 *
 * ONE COPY OF THE SITE
 * --------------------
 * The site used to exist twice — ./site and src/dashboard/public/learn — as
 * 356 KB of duplicated assets each. They drifted, and not harmlessly: four of
 * the twelve content modules in ./site had literal newlines inside double-quoted
 * JavaScript strings, which is a SYNTAX ERROR, so `npm run learn` served a site
 * where a third of the curriculum silently failed to load. The dashboard's copy
 * was also a CSS fix ahead.
 *
 * So there is now one source, under the dashboard's public directory, and both
 * entry points serve it. A duplicate that drifts is worse than a shared path.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// The single source for the study site, shared with the dashboard's /learn mount.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dashboard', 'public', 'learn');
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
