# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:
open the repository's **Security** tab and choose **Report a vulnerability**.
Include what you found, how to reproduce it, and what an attacker could do with it.

## How JobAgent is meant to run

JobAgent is a local tool. It runs on your own machine and is not designed to be
hosted for other people.

- The dashboard listens on `127.0.0.1` only. It rejects requests with a
  non-loopback `Host` header (DNS rebinding), cross-site requests (Fetch
  Metadata), and state-changing requests from other origins or without a JSON
  body or `X-Job-Agent` header (CSRF). Pages are served with a strict
  Content-Security-Policy that blocks inline scripts.
- Job postings are untrusted text. The dashboard renders them as text, never as
  HTML, and only opens `http(s)` links. Database queries use bound parameters.
- The optional browser extension talks only to `127.0.0.1`, injects nothing into
  pages until you click it, and needs a 32+ byte shared key
  (`JOB_AGENT_EXTENSION_KEY`).
- The optional LLM assist is off by default. When on, it receives only the public
  job description and title, and every phrase it returns must appear verbatim in
  that posting.
- Nothing is submitted to an employer unless you opt in for that run; the
  default mode is `DRY_RUN`.

## Keeping your data private

Your profile, answers, resume, job database and `.env` are git-ignored. Never
force-add them, and never expose the dashboard port to a network (for example
with port forwarding or a tunnel).
