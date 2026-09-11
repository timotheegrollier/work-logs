import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)) throw new Error(`Version invalide : ${version}`);
const tag = process.argv[2];
if (tag && tag !== `v${version}`) throw new Error(`Le tag ${tag} doit correspondre à package.json : v${version}`);
console.log(`Version de release : v${version}`);
