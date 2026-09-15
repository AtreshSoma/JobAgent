/**
 * Cover letter generator (deterministic, template-based).
 *
 * Assembles a cover letter from config/cover_letter.json + the candidate profile
 * + the job, then runs the humanizer to strip banned phrases and em dashes.
 * No AI is called here; an optional `compose` function can be injected later for
 * an AI-backed variant, but the default is fully deterministic and testable.
 *
 * A letter is only produced when generation is warranted:
 *   - coverLetter.enabled is true, AND
 *   - the job is flagged `required`, OR the score meets minScoreToGenerate.
 *
 * Output never fabricates: every claim is drawn from candidate.json. Word count
 * is bounded by config (optional paragraphs are dropped to fit max).
 */

import { humanize, hasBannedContent } from './humanizer.js';

/**
 * @param {object} job normalized job (title, company, ...)
 * @param {object} scoreResult output of scoreJob (total, matchedKeywords)
 * @param {object} args
 * @param {object} args.coverLetter parsed config/cover_letter.json
 * @param {object} args.candidate parsed config/candidate.json
 * @param {object} args.humanizerPatterns parsed config/humanizer_patterns.json
 * @param {boolean} [args.required=false] employer requires a cover letter
 * @param {(ctx: object) => string} [args.compose] optional custom composer
 * @returns {{ generated: boolean, reason: string, text: string|null, wordCount: number }}
 */
export function generateCoverLetter(job, scoreResult, {
  coverLetter, candidate, humanizerPatterns, required = false, compose,
} = {}) {
  if (!coverLetter?.enabled) {
    return skip('cover letters disabled in config');
  }
  const score = scoreResult?.total ?? 0;
  if (!required && score < coverLetter.minScoreToGenerate) {
    return skip(`score ${score} below minScoreToGenerate ${coverLetter.minScoreToGenerate} and not required`);
  }

  const ctx = buildContext(job, scoreResult, candidate, coverLetter);
  let body = typeof compose === 'function' ? compose(ctx) : composeDefault(ctx, coverLetter);

  body = humanize(body, humanizerPatterns);
  body = enforceWordCount(body, coverLetter.wordCount);

  const text = [coverLetter.greeting, '', body, '', coverLetter.closing, candidate?.identity?.fullName]
    .filter((l) => l !== undefined)
    .join('\n');

  const wordCount = countWords(body);
  return {
    generated: true,
    reason: required ? 'required by employer' : `score ${score} >= ${coverLetter.minScoreToGenerate}`,
    text,
    wordCount,
    cleaned: !hasBannedContent(text, humanizerPatterns),
  };
}

function buildContext(job, scoreResult, candidate, coverLetter) {
  const matched = (scoreResult?.matchedKeywords ?? []);
  const skills = matched.slice(0, coverLetter.maxSkillBullets ?? 5);
  // NO UNGROUNDED CLAIMS, AND NO BORROWED PROFESSION.
  //
  // `topHighlight` used to fall back to the literal string 'delivered production
  // data pipelines'. With an empty workHistory[0].highlights the letter asserted
  // a specific accomplishment the candidate had never described — in a document
  // sent to an employer — and for anyone outside data engineering it asserted a
  // job they had never done. `headline` and `focusAreas` defaulted to
  // 'data engineer' the same way.
  //
  // A missing highlight is now null, and `composeDefault` omits that paragraph
  // rather than inventing one. This mirrors the rule the resume tailor enforces
  // with invariants: emit only what the profile evidences.
  const highlights = (candidate?.workHistory?.[0]?.highlights ?? [])
    .filter((h) => typeof h === 'string' && h.trim());
  const topHighlight = highlights.length
    ? lowerFirst(stripTrailingPeriod(highlights[0]))
    : null;
  const domains = (candidate?.domainExperience ?? []).slice(0, 3).join(', ') || null;
  const stackTerms = Object.values(candidate?.technicalStack ?? {}).flat().filter(Boolean);
  const focusAreas = skills.length
    ? skills.slice(0, 3).join(', ')
    : (stackTerms.slice(0, 3).join(', ') || null);
  return {
    title: job?.title ?? 'this role',
    company: job?.company ?? 'your company',
    headline: candidate?.identity?.headline
      ?? candidate?.targetTitles?.[0]
      ?? 'candidate',
    years: coverLetter.yearsOfExperience ?? 'several years',
    skills,
    topHighlight,
    domains,
    focusAreas,
    includeSponsorshipNote: coverLetter.includeSponsorshipNote && candidate?.workAuthorization?.requiresSponsorship,
  };
}

function composeDefault(ctx, coverLetter) {
  const t = coverLetter.template;
  const paragraphs = [];

  paragraphs.push(fill(t.opening, ctx));

  if (ctx.skills.length) {
    const bullets = ctx.skills.map((s) => `- ${s}`).join('\n');
    paragraphs.push(`${t.skillsLead}\n${bullets}`);
  }

  // Both of these are omitted rather than filled with a placeholder when the
  // profile does not evidence them. A shorter, true letter beats a complete,
  // invented one.
  if (ctx.topHighlight) paragraphs.push(fill(t.experience, ctx));
  if (ctx.focusAreas) paragraphs.push(fill(t.fitNote, ctx));

  if (ctx.includeSponsorshipNote) {
    paragraphs.push(fill(t.sponsorshipNote, ctx));
  }

  paragraphs.push(fill(t.closingParagraph, ctx));
  return paragraphs.join('\n\n');
}

/** Drop optional trailing paragraphs (then sentences) to satisfy max words. */
function enforceWordCount(body, wordCount = {}) {
  const max = wordCount.max ?? Infinity;
  if (countWords(body) <= max) return body;

  // Remove middle paragraphs first, always preserving the opening (intro) and
  // the final two (sponsorship note + closing) so required statements survive.
  const paras = body.split('\n\n');
  while (paras.length > 3 && countWords(paras.join('\n\n')) > max) {
    paras.splice(2, 1);
  }
  let trimmed = paras.join('\n\n');

  // If still over, trim sentences from the body (excluding closing).
  if (countWords(trimmed) > max) {
    const sentences = trimmed.split(/(?<=[.])\s+/);
    while (sentences.length > 1 && countWords(sentences.join(' ')) > max) {
      sentences.splice(sentences.length - 2, 1);
    }
    trimmed = sentences.join(' ');
  }
  return trimmed;
}

function fill(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (ctx[key] !== undefined ? String(ctx[key]) : ''));
}

function countWords(s) {
  return (s.match(/\b[\w'-]+\b/g) ?? []).length;
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function stripTrailingPeriod(s) {
  return s.replace(/\.\s*$/, '');
}

function skip(reason) {
  return { generated: false, reason, text: null, wordCount: 0, cleaned: true };
}
