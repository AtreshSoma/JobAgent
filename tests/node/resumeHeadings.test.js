/**
 * The Node resume parser reads the same headings the Python tailor does.
 *
 * Measured 2026-11-12 on a real resume (docs/RESUME_TAILORING_PLAN.md, P0): the
 * parser found 0 job titles, so the profile kept the template's title and search
 * returned jobs for a different field. Causes pinned here: a drawing's position
 * numbers glued to the heading text, headings with two qualifier words, detail
 * after a comma, and skills split inside brackets. Examples are generic.
 */
import { describe, expect, it } from 'vitest';

import { paragraphsFromDocumentXml } from '../../src/resume/docxText.js';
import { extractResumeEvidence, splitSections } from '../../src/resume/resumeProfile.js';

const kinds = (lines) => splitSections(lines).map((s) => s.kind);

describe('drawing positions are not text', () => {
  const drawing = (h, v) => `<w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:posOffset>${h}</wp:posOffset></wp:positionH>`
    + `<wp:positionV relativeFrom="paragraph"><wp:align>${v}</wp:align></wp:positionV></wp:anchor></w:drawing></w:r>`;

  it('a heading next to an anchored shape is still just the heading', () => {
    const xml = `<w:body><w:p>${drawing('123456789', 'top')}<w:r><w:t>EXPERIENCE:</w:t></w:r></w:p>`
      + '<w:p><w:r><w:t>Senior Software Engineer, Acme Analytics</w:t></w:r></w:p></w:body>';
    expect(paragraphsFromDocumentXml(xml)).toEqual(['EXPERIENCE:', 'Senior Software Engineer, Acme Analytics']);
  });

  it('size and relative-position numbers beside a heading are dropped too', () => {
    // wp14 writes "0" for width/height percentages; the heading read "00EXPERIENCE:".
    const sized = '<w:r><w:drawing><wp:anchor><wp14:sizeRelH relativeFrom="margin"><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH>'
      + '<wp14:sizeRelV relativeFrom="margin"><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV>'
      + '<wp14:pctPosHOffset>0</wp14:pctPosHOffset><wp14:pctPosVOffset>1000</wp14:pctPosVOffset></wp:anchor></w:drawing></w:r>';
    const xml = `<w:body><w:p>${sized}<w:r><w:t>SKILLS:</w:t></w:r></w:p></w:body>`;
    expect(paragraphsFromDocumentXml(xml)).toEqual(['SKILLS:']);
  });

  it('keeps every real run of text, including a text box inside a drawing', () => {
    const xml = '<w:body><w:p><w:r><w:t>Name</w:t></w:r><w:r><w:drawing><wp:anchor><wp:positionH><wp:posOffset>-914400</wp:posOffset></wp:positionH>'
      + '<w:txbxContent><w:p><w:r><w:t>person@example.com</w:t></w:r></w:p></w:txbxContent></wp:anchor></w:drawing></w:r></w:p></w:body>';
    const text = paragraphsFromDocumentXml(xml).join(' ');
    expect(text).toContain('person@example.com');
    expect(text).not.toMatch(/914400/);
  });
});

describe('headings in the shapes real resumes use', () => {
  it.each([
    ['PROFESSIONAL EXPERIENCE:', 'experience'],
    ['Relevant Work Experience', 'experience'],
    ['Professional Work Experience:', 'experience'],
    ['TECHNICAL SKILLS:', 'skills'],
    ['EDUCATION:', 'education'],
    ['Projects, Example Organisation', 'projects'],
    ['Volunteer Work Experience', 'other'],
    ['Professional Affiliations', 'other'],
  ])('%s is a %s heading', (line, kind) => {
    expect(kinds(['Some Name', line, 'one line under it']).slice(1)[0]).toBe(kind);
  });

  it.each([
    'Experience with large distributed systems and data pipelines',
    'Skills gap analysis for the support team, Example Corp, 2019 - 2021',
    'Led the migration of the reporting platform:',
  ])('does not take "%s" for a heading', (line) => {
    expect(kinds(['Some Name', line])).toEqual(['header']);
  });

  it('a heading with a drawing anchor glued on still ends the section above it', () => {
    const lines = ['Some Name', 'SKILLS:', 'Python, SQL', '123456789EXPERIENCE:', 'Senior Software Engineer, Acme Analytics'];
    expect(kinds(lines)).toEqual(['header', 'skills', 'experience']);
  });
});

describe('skills are split outside brackets only', () => {
  const skills = (lines) => extractResumeEvidence(['Some Name', 'SKILLS:', ...lines]).skills;

  it('keeps "Databases (SQL, NoSQL)" as one item, with no broken halves', () => {
    const out = skills(['Data: Databases (SQL, NoSQL), Warehousing, Kafka']);
    expect(out).toEqual(['Databases', 'Warehousing', 'Kafka']);
    expect(out.join('|')).not.toMatch(/[()]/);
  });

  it('still splits plain lists and unbalanced brackets safely', () => {
    expect(skills(['Python, Java; Go | Rust'])).toEqual(['Python', 'Java', 'Go', 'Rust']);
    expect(skills(['Cloud (AWS, Azure'])).toContain('Cloud');
  });
});
