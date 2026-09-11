/**
 * Génère la note de release (anglais) à partir de l'historique Git.
 * Utilisé par `.github/workflows/release.yml` : chaque release publiée
 * reçoit la même structure — What's new, Fixes, Dependencies, téléchargements.
 *
 * Usage : `node scripts/release-notes.mjs v0.4.1 [--release-dir release]`
 * Imprime le Markdown sur stdout. Les sujets de commits sont repris tels quels ;
 * tout le reste (titres, aide au téléchargement, vérification) est en anglais.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homepage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).homepage.replace(/\/$/, '');

const RULES = [
  ['new', /^(feat|add|nouveaut|nouvelle|nouveau|ajoute)/i],
  ['fixes', /^(fix|corrige|r[ée]pare|bug)/i],
  ['deps', /^(chore\(deps\)|build\(deps|bump|deps|upgrade|maj\b|mise à jour des d[ée]pendances)/i],
];

export function categorize(subject) {
  for (const [section, pattern] of RULES) {
    if (pattern.test(subject.trim())) return section;
  }
  return 'other';
}

/** Dernier tag semver strictement inférieur à `tag` (le précédent release). */
export function previousTag(tag, allTags) {
  const parse = (t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t)?.slice(1).map(Number) ?? null;
  const current = parse(tag);
  if (!current) return null;
  const older = allTags.filter((t) => {
    const v = parse(t);
    return v && (v[0] < current[0]
      || (v[0] === current[0] && (v[1] < current[1]
        || (v[1] === current[1] && v[2] < current[2]))));
  });
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return older.map((t) => [t, parse(t)]).sort((x, y) => cmp(x[1], y[1])).at(-1)?.[0] ?? null;
}

export function subjectsBetween(prev, tag) {
  const range = prev ? `${prev}..${tag}` : tag;
  try {
    return splitSubjects(execFileSync('git', ['log', range, '--no-merges', '--format=%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    // Aperçu local avant de taguer : le tag n'existe pas encore, on lit jusqu'à HEAD.
    if (!prev) throw new Error(`Ni tag ${tag} ni HEAD lisibles`);
    return splitSubjects(execFileSync('git', ['log', `${prev}..HEAD`, '--no-merges', '--format=%s'], { cwd: root, encoding: 'utf8' }));
  }
}

function splitSubjects(out) {
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function downloadTable(releaseDir) {
  const rows = [
    ['WorkLogs-{v}-linux-amd64.deb', 'Ubuntu 24.04, Linux Mint 22.x and other Debian-based distros'],
    ['WorkLogs-{v}-linux-x86_64.rpm', 'Fedora 43 / 44 and other RPM-based distros'],
    ['WorkLogs-{v}-linux-x86_64.AppImage', 'Any 64-bit distro, no install needed'],
  ];
  let table = '| File | For |\n|---|---|\n';
  for (const [pattern, audience] of rows) {
    const found = releaseDir
      ? fs.readdirSync(releaseDir).find((f) => f.endsWith(pattern.split('{v}-')[1]))
      : null;
    const file = pattern.replace('{v}', found?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '');
    const size = found ? ` (${(fs.statSync(path.join(releaseDir, found)).size / 1048576).toFixed(0)} MB)` : '';
    table += `| \`${file}\` | ${audience}${size} |\n`;
  }
  return table;
}

export function renderNotes({ tag, prev, subjects, releaseDir }) {
  const version = tag.replace(/^v/, '');
  const buckets = { new: [], fixes: [], deps: [], other: [] };
  for (const subject of subjects) buckets[categorize(subject)].push(subject);
  const titles = {
    new: "What's new", fixes: 'Fixes', deps: 'Dependencies', other: 'Other changes',
  };
  let notes = `## WorkLogs ${version} for Linux\n\nA 100% local work journal: write, lay out and organize — on a single screen, no account, no server.\n\n### Download\n\n${downloadTable(releaseDir)}\nVerify integrity with \`sha256sum -c SHA256SUMS\`.\n\nThe app checks for updates on launch and offers the download in one click.\n`;
  for (const key of ['new', 'fixes', 'deps', 'other']) {
    if (!buckets[key].length) continue;
    notes += `\n### ${titles[key]}\n\n${buckets[key].map((s) => `- ${s}`).join('\n')}\n`;
  }
  notes += `\n**Full changelog**: ${homepage}/compare/${prev ?? ''}...${tag}\n`;
  return notes;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const tag = process.argv[2];
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
    console.error('Usage : node scripts/release-notes.mjs vX.Y.Z [--release-dir release]');
    process.exit(2);
  }
  const dirFlag = process.argv.indexOf('--release-dir');
  const releaseDir = dirFlag === -1 ? null : path.resolve(root, process.argv[dirFlag + 1] ?? 'release');
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n').map((t) => t.trim()).filter(Boolean);
  const prev = previousTag(tag, tags);
  process.stdout.write(renderNotes({ tag, prev, subjects: subjectsBetween(prev, tag), releaseDir }));
}
