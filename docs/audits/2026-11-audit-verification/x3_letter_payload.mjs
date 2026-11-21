const repo = process.argv[2]; const master = process.argv[3];
const { COVER_LETTER_TASK } = await import(repo + '/src/apply/groundedLetter.js');
const { execFileSync } = await import('node:child_process');
const units = JSON.parse(execFileSync(repo + '/.venv/bin/python', ['-c', `import sys,json;sys.path.insert(0,'${repo}/src/resume');import tailor;print(json.dumps(tailor.master_units(sys.argv[1])))`, master]));
const bullets = units.filter((u) => u.kind === 'bullet' || u.kind === 'paragraph').slice(0, 60);
console.log(COVER_LETTER_TASK.buildUser({ company: 'Example Co', title: 'Data Engineer', requirements: [], bullets }).split('\n').slice(0, 10).join('\n'));
