/**
 * Long-lived Python workers for the tailor (audit R17).
 *
 * Every tailor request started a fresh interpreter that imported python-docx
 * and the tailor again: the tailoring itself, the HTML for the Chromium PDF,
 * the cover-letter DOCX, the master's units. Two or three starts per job, one
 * job at a time. A worker here is one `tailor_cli.py --serve` process that
 * answers JSON lines until it is let go; a pool of up to `size` of them serves
 * requests in parallel (Python does one at a time per worker).
 *
 * Failure is contained per request: one that times out kills its worker (and
 * whatever it launched, such as LibreOffice), one whose worker dies is
 * rejected with what it printed, and the next request starts a fresh worker.
 * Idle workers are let go after `idleMs`, and none ever keeps Node running.
 */

const DEFAULT_IDLE_MS = 60_000;

class Worker {
  constructor(child, onGone) {
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    this.pending = null; // { id, resolve, reject, timer }
    this.gone = false;
    this.idleTimer = null;
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this.onData(chunk));
    child.stderr?.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    child.stdin?.on?.('error', () => {});
    child.on('error', (err) => this.finish(err));
    child.on('close', (code) => this.finish(new Error(
      `the Python worker stopped (exit ${code ?? 'signal'})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`,
    )));
    this.onGone = onGone;
    // Never hold Node open: an in-flight request's timer does that.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
    child.unref?.();
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line || !this.pending) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      if (reply._id !== this.pending.id && reply._id !== null) continue;
      const { resolve, timer } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      delete reply._id;
      resolve(reply);
    }
  }

  send(id, request, timeoutMs, kill) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        kill(this.child);
        this.finish(null);
        reject(new Error(`python tailor timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(`${JSON.stringify({ ...request, _id: id })}\n`);
    });
  }

  finish(err) {
    if (this.pending && err) {
      const { reject, timer } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      reject(err);
    }
    if (!this.gone) {
      this.gone = true;
      clearTimeout(this.idleTimer);
      this.onGone(this);
    }
  }
}

export class PythonPool {
  /**
   * @param {object} options
   * @param {() => import('node:child_process').ChildProcess} options.spawn starts one `--serve` worker
   * @param {number} [options.size=2] most workers at once
   * @param {number} [options.idleMs=60000] let an idle worker go after this
   * @param {(child: object) => void} [options.kill] stop a worker and what it launched
   */
  constructor({ spawn, size = 2, idleMs = DEFAULT_IDLE_MS, kill = (child) => child.kill?.() } = {}) {
    this.spawn = spawn;
    this.max = Math.max(1, Math.min(4, Number(size) || 2));
    this.idleMs = idleMs;
    this.kill = kill;
    this.workers = new Set();
    this.idle = [];
    this.queue = [];
    this.nextId = 1;
  }

  size() {
    return this.workers.size;
  }

  /**
   * Send one request to a free worker, starting one when none is free and the
   * pool has room; otherwise wait in line.
   *
   * @param {object} request the JSON request tailor_cli.py takes
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<object>} the reply, without its `_id`
   */
  request(request, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      let worker = this.idle.pop();
      if (!worker) {
        if (this.workers.size >= this.max) return;
        try {
          worker = new Worker(this.spawn(), (w) => this.forget(w));
        } catch (err) {
          this.queue.shift().reject(err);
          continue;
        }
        this.workers.add(worker);
      }
      clearTimeout(worker.idleTimer);
      const job = this.queue.shift();
      const id = this.nextId;
      this.nextId += 1;
      worker.send(id, job.request, job.timeoutMs, this.kill).then(
        (reply) => { this.release(worker); job.resolve(reply); },
        (err) => { job.reject(err); this.pump(); },
      );
    }
  }

  release(worker) {
    if (worker.gone) return;
    this.idle.push(worker);
    worker.idleTimer = setTimeout(() => this.retire(worker), this.idleMs);
    worker.idleTimer.unref?.();
    this.pump();
  }

  retire(worker) {
    this.idle = this.idle.filter((w) => w !== worker);
    worker.child.stdin?.end?.();
  }

  forget(worker) {
    this.workers.delete(worker);
    this.idle = this.idle.filter((w) => w !== worker);
  }

  /** Let every worker go (shutdown, tests). */
  async close() {
    this.queue.splice(0).forEach((job) => job.reject(new Error('the Python pool was closed')));
    // The timer is NOT unref'd: shutdown waits (at most two seconds) for the
    // workers to go, and every other handle here is unref'd.
    const closing = [...this.workers].map((w) => new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      w.child.once?.('close', () => { clearTimeout(timer); resolve(); });
      w.child.stdin?.end?.();
    }));
    await Promise.all(closing);
  }
}
