# Master resume

Place YOUR master resume here as MASTER_RESUME.docx.

  npm run setup

copies MASTER_RESUME.example.docx into place if you have not supplied one yet,
so a fresh clone can run the tailor and the test suite immediately. That example
is SYNTHETIC — "Jane Doe", invented employers — and is there to make the code
runnable, not to represent you. Replace it before preparing a real application;
`npm run doctor` refuses to proceed while placeholder details remain.

  - MASTER_RESUME.docx is READ-ONLY to the system and is NEVER overwritten.
  - It is gitignored. It holds your name, phone, email and employment history,
    and must not be committed. Only the synthetic example is tracked.
  - Tailored drafts are written to ../output/ with generated names.
  - Timestamped copies are written to ./history/ before any edit.
