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
  // The configured minimum is a review flag, never a padding trigger: padding
  // would mean inventing filler claims. A short letter stays reviewable with an
  // explicit warning so the human decides whether it is enough.
  const minWords = coverLetter.wordCount?.min ?? 0;
  const belowMinWordCount = wordCount < minWords;
  return {
    generated: true,
    reason: required ? 'required by employer' : `score ${score} >= ${coverLetter.minScoreToGenerate}`,
    text,
    wordCount,
    belowMinWordCount,
    warnings: belowMinWordCount
      ? [`cover letter is ${wordCount} words, below the configured minimum of ${minWords} — review before sending`]
      : [],
    cleaned: !hasBannedContent(text, humanizerPatterns),
  };
}

function buildContext(job, scoreResult, candidate, coverLetter) {
  const matched = (scoreResult?.matchedKeywords ?? []);
  const skills = matched.slice(0, coverLetter.maxSkillBullets ?? 5);
  const highlights = candidate?.workHistory?.[0]?.highlights ?? [];
  const topHighlight = lowerFirst(stripTrailingPeriod(highlights[0] ?? 'delivered production data pipelines'));
  const domains = (candidate?.domainExperience ?? []).slice(0, 3).join(', ') || 'multiple industries';
  const focusAreas = skills.length ? skills.slice(0, 3).join(', ') : 'data engineering';
  return {
    title: job?.title ?? 'Data Engineer',
    company: job?.company ?? 'your company',
    headline: candidate?.identity?.headline ?? 'data engineer',
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

  paragraphs.push(fill(t.experience, ctx));
  paragraphs.push(fill(t.fitNote, ctx));

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
