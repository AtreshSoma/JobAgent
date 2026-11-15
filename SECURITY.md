# Security

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:
open the repository's **Security** tab and choose **Report a vulnerability**.
Include what you found, how to reproduce it, and what an attacker could do with it.

## How JobAgent is meant to run

JobAgent is a local tool. It runs on your own machine and is not designed to be
hosted for other people.

- The dashboard listens on `127.0.0.1` only. It rejects requests with a
  missing or non-loopback `Host` header (DNS rebinding), cross-site requests
  (Fetch Metadata), and state-changing requests from other origins or without a
  JSON body or `X-Job-Agent` header (CSRF). Pages are served with a strict
  Content-Security-Policy that blocks inline scripts.
- Every API request also needs the dashboard's access token, a random 256-bit
  value in `data/.dashboard-token` that only your user account can read. The
  launcher opens a link carrying it once, and it is exchanged for an HttpOnly,
  SameSite=Strict cookie. Other programs and other user accounts on the same
  computer cannot use the API without it. `npm run dashboard:link` prints the
  link again.
- URLs from you or from job postings (Add by URL, link checks, description
  enrichment, careers pages) are fetched only if every address they resolve to
  is public. The check runs when the connection is made, on every redirect, so
  a hostname that resolves to this computer or your network is refused.
- Job postings are untrusted text. The dashboard renders them as text, never as
  HTML, and only opens `http(s)` links. Database queries use bound parameters.
- The optional browser extension talks only to `127.0.0.1`, injects nothing into
  pages until you click it, and needs a 32+ byte shared key
  (`JOB_AGENT_EXTENSION_KEY`).
- The optional LLM assist is off by default. Requirement extraction, the only
  thing `LLM_ASSIST=on` does by itself, receives only the public job description
  and title, and every phrase it returns must appear verbatim in that posting.
  Features with their own switch send more: `RESUME_REWRITE=suggest` (rewrites
  and refine) sends resume bullets with their role lines; `COVER_LETTER_MODE=grounded`
  sends the resume's summary, headline and bullets and the master cover letter's
  paragraphs; drafting a reply sends resume bullets and the reply's subject and
  flagged sentence; `INBOX_LLM=on` sends up to 6,000 characters of an email body
  to sort it; `RERANK=on` sends resume bullets and the top matches' descriptions
  to an embeddings model. Your name and contact details are never sent by any of
  them: lines carrying a name, email address, phone number or profile link are
  dropped first (`src/llm/identityUnits.js`). Screening answers, EEO answers and
  salary expectations are not sent. A local provider (Ollama, LM Studio) keeps all
  of it on your computer.
- Nothing is submitted to an employer unless you opt in for that run; the
  default mode is `DRY_RUN`.

## Keeping your data private

Your profile, answers, resume, job database and `.env` are git-ignored. Never
force-add them, and never expose the dashboard port to a network (for example
with port forwarding or a tunnel).

### What is stored on this computer, and how

Everything JobAgent keeps is in its own folder, as **ordinary, unencrypted
files**. Anyone who can read that folder (another account with access to it,
a backup service, a stolen laptop without disk encryption) can read them:

- your profile, screening answers and settings (`config/`), and any API keys in `.env`;
- your master resume, cover letters and every tailored document (`resumes/`, `applications/`);
- the job database and logs (`data/`, `logs/`);
- **one browser profile folder per person** (`.browser-profile-…`), which holds
  live sign-ins to every application site auto-fill used, such as Workday or iCIMS.

What this means in practice:

- Turn on your operating system's disk encryption (FileVault on macOS,
  BitLocker on Windows). JobAgent does not encrypt its working folder.
- The **Export everything** backup can be encrypted with a passphrase; the
  working copy cannot.
- **System health → Sign out everywhere** removes the active person's browser
  profile folder, which signs them out of every application site on this
  computer. Close any auto-fill window first; the next auto-fill asks you to
  sign in again.
