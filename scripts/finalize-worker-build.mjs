import { access, readFile } from 'node:fs/promises';
await access(new URL('../dist/server/index.js', import.meta.url));
await access(new URL('../dist/client/index.html', import.meta.url));
const hosting = JSON.parse(await readFile(new URL('../dist/.openai/hosting.json', import.meta.url), 'utf8'));
if (hosting.static || hosting.d1 !== 'DB') throw new Error('Worker artifact must preserve the DB binding.');
console.log('Spondion Worker, client assets and DB manifest verified.');
