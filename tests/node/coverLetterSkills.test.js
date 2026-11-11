import { describe, it, expect } from 'vitest';
import { presentableSkills } from '../../src/apply/coverLetter.js';

const candidate = {
  technicalStack: {
    core: ['Azure Data Factory', 'Databricks', 'PySpark', 'SQL'],
    background: ['Kafka', 'Structured Streaming', 'dbt Core'],
    growth: ['Snowflake', 'Airflow'], // WANTS to learn — never a claimed strength
  },
};

describe('presentableSkills — what a cover letter may say the candidate can do', () => {
  it('never claims a JD term the candidate has not evidenced, including growth skills', () => {
    const out = presentableSkills(['databricks', 'snowflake', 'airflow', 'terraform'], candidate);
    expect(out).toEqual(['Databricks']);
  });

  it('drops role titles and terms already covered by a longer listed term', () => {
    expect(presentableSkills(['data engineer', 'azure', 'azure data factory'], candidate)).toEqual(['Azure Data Factory']);
  });

  it("uses the candidate's own spelling, brand casing and upper-case acronyms", () => {
    expect(presentableSkills(['pyspark', 'sql', 'kafka', 'dbt'], candidate)).toEqual(['PySpark', 'SQL', 'Kafka', 'dbt']);
  });
});
