import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/measure-ai-prompts.mjs');
let directory;
let baseline;
let baselinePath;
const run = (...args) => execFileSync(process.execPath, [script, ...args], {
  cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
});

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-ai-measure-test-'));
  baselinePath = path.join(directory, 'before.json');
  run('--output', baselinePath);
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
});
after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

test('le corpus mesure les requêtes réelles sans réseau et distingue octets, caractères et plafond de sortie', () => {
  assert.equal(baseline.schema_version, 1);
  assert.match(baseline.fixture_sha256, /^[a-f0-9]{64}$/);
  assert.match(baseline.source_sha256['ai-suggest.ts'], /^[a-f0-9]{64}$/);
  assert.match(baseline.measures, /ni tokens facturés/);
  const names = baseline.cases.map((value) => value.name);
  for (const feature of ['connexion', 'contexte/', 'sous-taches/', 'relecture/', 'completer/', 'procedure/', 'extraire/', 'suggerer-taches/', 'affiner/', 'rechercher-document/', 'prioriser/', 'conseiller/', 'suivi/', 'bilan/', 'replanifier/']) {
    assert(names.some((name) => name.startsWith(feature)), `Fonctionnalité absente du corpus : ${feature}`);
  }
  assert.equal(baseline.totals.input_chars, baseline.cases.reduce((total, value) => total + value.input_chars, 0));
  assert.equal(baseline.totals.input_utf8_bytes, baseline.cases.reduce((total, value) => total + value.input_utf8_bytes, 0));
  assert(baseline.totals.input_utf8_bytes > baseline.totals.input_chars);
  for (const value of baseline.cases) {
    assert.equal(value.input_chars, value.system_chars + value.user_chars);
    assert.equal(value.input_tokens, undefined, 'Une longueur de texte ne devient pas un nombre de tokens.');
  }
  assert.equal(baseline.cases.find((value) => value.name === 'affiner/texte-identique').retained_evidence.length, 5);
  assert.equal(baseline.cases.find((value) => value.name === 'replanifier/60').selected_items_represented, 60);
  assert.equal(baseline.cases.find((value) => value.name === 'suivi/documents-identiques').selected_items_represented, 8);
  assert(baseline.cases.find((value) => value.name === 'connexion').output_token_ceiling > 0);
});

test('un même corpus et les mêmes sources donnent une comparaison nulle', () => {
  const output = path.join(directory, 'same.json');
  run('--compare', baselinePath, '--output', output);
  const compared = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(compared.totals.input_chars_change_pct, 0);
  assert(compared.cases.every((value) => value.input_chars_change_pct === 0));
  assert.deepEqual(compared.source_sha256, baseline.source_sha256);
});

test('la comparaison refuse corpus modifié, chiffres incohérents et perte d’un indice préservé', () => {
  const badPath = path.join(directory, 'bad.json');
  const denied = (mutate, pattern) => {
    const bad = structuredClone(baseline);
    mutate(bad);
    fs.writeFileSync(badPath, JSON.stringify(bad));
    assert.throws(() => run('--compare', badPath), (error) => error.status === 1 && pattern.test(String(error.stderr)));
  };
  denied((bad) => { bad.fixture_sha256 = '0'.repeat(64); }, /Corpus différents/);
  denied((bad) => { bad.cases[0].input_chars += 1; }, /total incohérent/);
  denied((bad) => { bad.cases[0].retained_evidence.push('FAIT_QUI_NE_FIGURE_PAS_DANS_LE_PROMPT'); }, /fait auparavant présent désormais absent/);
});
