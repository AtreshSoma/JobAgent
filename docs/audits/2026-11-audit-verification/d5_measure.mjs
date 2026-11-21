const [repo, dbPath] = process.argv.slice(2);
const { openDatabase } = await import(repo + '/src/logging/db.js');
const db = openDatabase({ path: dbPath });
const N = 50000; const jd = 'Build data pipelines with Spark and Airflow. '.repeat(180); // ~8 KB
const t0 = performance.now();
db.db.exec('BEGIN');
for (let i = 0; i < N; i++) db.upsertJob({ id: `j${i}`, title: `Data Engineer ${i}`, company: `Example ${i % 900}`, url: `https://example.com/j/${i}`, score: (i * 37) % 100, tier: 'Apply', jd_text: jd, status: 'new', source: 'test' });
db.db.exec('COMMIT');
console.log('insert', N, Math.round(performance.now() - t0), 'ms');
const time = (label, fn) => { const s = performance.now(); const r = fn(); const ms = Math.round(performance.now() - s); const mb = Math.round(process.memoryUsage().rss / 1e6); console.log(label, Array.isArray(r) ? r.length : r, ms + 'ms', 'rss', mb + 'MB'); };
time('listJobsSummary', () => db.listJobsSummary({}));
time('listJobs (SELECT *)', () => db.listJobs({}));
time('count(*)', () => db.db.prepare('SELECT count(*) n FROM jobs').get().n);
db.close();
