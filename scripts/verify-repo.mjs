/**
 * Vérifie que les dépôts publics de la branche `gh-pages` servent bien la
 * version qui vient d'être publiée.
 *
 * Un push sur `gh-pages` n'est pas visible partout au même instant : après la
 * v0.70.0, le nouveau `.deb` a répondu `503` quelques minutes alors que l'index
 * annonçait déjà la version. `apt` et `dnf` échouaient donc au téléchargement.
 * Ce script attend, avec une borne, que les index et les deux paquets soient
 * réellement joignables ; le workflow « Dépôts » échoue explicitement sinon.
 *
 * Usage : node scripts/verify-repo.mjs <tag> <base-url> [--skip-deb]
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseOf = (baseUrl) => String(baseUrl).replace(/\/+$/, '');

async function fetchBytes(url, fetchImpl, method = 'GET') {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`${method} ${url} : ${error.message}`);
  }
  if (!response.ok) throw new Error(`${method} ${url} → HTTP ${response.status}`);
  return { response, bytes: method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer()) };
}

async function fetchText(url, fetchImpl) {
  const { bytes } = await fetchBytes(url, fetchImpl);
  return bytes.toString('utf8');
}

async function assertServed(url, fetchImpl) {
  await fetchBytes(url, fetchImpl, 'HEAD');
}

function fieldsOf(block) {
  const fields = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  return fields;
}

function stanzas(text) {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(fieldsOf);
}

/** Nom du `.deb` de `version` dans un index Packages, ou une erreur explicite. */
function packagesAsset(text, version, label) {
  const stanza = stanzas(text).find((fields) => fields.package === 'worklogs' && fields.version === version);
  if (!stanza) throw new Error(`${label} ne liste pas worklogs ${version}`);
  if (!stanza.filename) throw new Error(`${label} : entrée ${version} sans Filename`);
  return stanza.filename.replace(/^\.\//, '');
}

/** Sommes SHA256 lues dans le fichier Release d'APT (section dédiée). */
function releaseSums(text) {
  const sums = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (/^SHA256:\s*$/.test(line)) {
      section = 'sha256';
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9-]*:/.test(line)) {
      section = '';
      continue;
    }
    if (section !== 'sha256') continue;
    const match = /^\s*([0-9a-f]{64})\s+\d+\s+(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

function primaryBlock(repomd) {
  const match = /<data\b[^>]*\btype="primary"[^>]*>([\s\S]*?)<\/data>/.exec(repomd);
  if (!match) throw new Error('repomd.xml sans données primary');
  const href = /<location\b[^>]*\bhref="([^"]+)"/.exec(match[1])?.[1];
  const checksum = /<checksum\b[^>]*\btype="sha256"[^>]*>([0-9a-f]{64})<\/checksum>/.exec(match[1])?.[1];
  if (!href || !checksum) throw new Error('repomd.xml : primary sans href ou empreinte sha256');
  return { href, checksum };
}

/** Nom du RPM de `version` dans le primary.xml dnf, ou une erreur explicite. */
function rpmAsset(primary, version) {
  const packages = primary.match(/<package\b[\s\S]*?<\/package>/g) || [];
  const stanza = packages.find((block) => new RegExp(`<version\\b[^>]*\\bver="${escapeRegex(version)}"`).test(block));
  if (!stanza) throw new Error(`primary.xml ne liste pas worklogs ${version}`);
  const href = /<location\b[^>]*\bhref="([^"]+)"/.exec(stanza)?.[1];
  if (!href) throw new Error(`primary.xml : entrée ${version} sans location`);
  return href;
}

/** Une seule passe : lève dès qu'un index ou un paquet public ne répond pas. */
export async function verifyOnce({ tag, baseUrl, fetchImpl = fetch, skipDeb = false }) {
  const version = String(tag).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`tag inattendu : ${tag}`);
  const base = baseOf(baseUrl);
  const checked = [];

  if (!skipDeb) {
    const packagesBytes = (await fetchBytes(`${base}/deb/Packages`, fetchImpl)).bytes;
    const packagesGzBytes = (await fetchBytes(`${base}/deb/Packages.gz`, fetchImpl)).bytes;
    let packagesGzText;
    try {
      packagesGzText = gunzipSync(packagesGzBytes).toString('utf8');
    } catch {
      throw new Error('Packages.gz illisible');
    }
    const deb = packagesAsset(packagesBytes.toString('utf8'), version, 'Packages');
    const debGz = packagesAsset(packagesGzText, version, 'Packages.gz');
    if (deb !== debGz) throw new Error(`Packages et Packages.gz divergent (${deb} / ${debGz})`);

    const release = releaseSums(await fetchText(`${base}/deb/Release`, fetchImpl));
    for (const [name, bytes] of [['Packages', packagesBytes], ['Packages.gz', packagesGzBytes]]) {
      const expected = release.get(name);
      if (!expected) throw new Error(`Release ne couvre pas ${name}`);
      if (expected !== sha256(bytes)) throw new Error(`Release : empreinte de ${name} incorrecte`);
    }

    await assertServed(`${base}/deb/worklogs.list`, fetchImpl);
    await assertServed(new URL(deb, `${base}/deb/`).href, fetchImpl);
    checked.push(`deb ${version}`);
  }

  const repomd = await fetchText(`${base}/rpm/repodata/repomd.xml`, fetchImpl);
  const primary = primaryBlock(repomd);
  const primaryBytes = (await fetchBytes(new URL(primary.href, `${base}/rpm/`).href, fetchImpl)).bytes;
  if (sha256(primaryBytes) !== primary.checksum) throw new Error('repomd.xml : empreinte du primary incorrecte');
  let primaryText;
  try {
    primaryText = gunzipSync(primaryBytes).toString('utf8');
  } catch {
    throw new Error('primary.xml.gz illisible');
  }
  const rpm = rpmAsset(primaryText, version);

  await assertServed(`${base}/rpm/worklogs.repo`, fetchImpl);
  await assertServed(new URL(rpm, `${base}/rpm/`).href, fetchImpl);
  checked.push(`rpm ${version}`);

  return { version, checked };
}

/**
 * Répète `verifyOnce` jusqu'à la réussite ou la fin du délai. Le dernier échec
 * est conservé : en cas d'expiration, le message dit précisément ce qui manque.
 */
export async function verifyRepo({
  tag,
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  skipDeb = false,
  log = () => {},
}) {
  const started = Date.now();
  let attempts = 0;
  let lastError;

  for (;;) {
    attempts += 1;
    try {
      const result = await verifyOnce({ tag, baseUrl, fetchImpl, skipDeb });
      return { ...result, attempts, elapsedMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) break;
      const wait = Math.min(intervalMs, remaining);
      log(`essai ${attempts} : ${error.message} — nouvelle tentative dans ${Math.round(wait / 1000)} s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw new Error(
    `Dépôts publics non prêts pour ${tag} après ${Math.round(timeoutMs / 1000)} s ` +
      `(${attempts} essai(s)) : ${lastError?.message || 'inconnu'}`,
  );
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const [tag, baseUrl, ...flags] = process.argv.slice(2);
  if (!tag || !baseUrl) {
    console.error('Usage : node scripts/verify-repo.mjs <tag> <base-url> [--skip-deb]');
    process.exit(2);
  }
  verifyRepo({ tag, baseUrl, skipDeb: flags.includes('--skip-deb'), log: (message) => console.log(message) })
    .then(({ version, checked, attempts, elapsedMs }) => {
      console.log(
        `Dépôts publics vérifiés : ${version} (${checked.join(', ')}) en ${attempts} essai(s), ` +
          `${Math.round(elapsedMs / 1000)} s.`,
      );
    })
    .catch((error) => {
      console.error(`::error::${error.message}`);
      process.exit(1);
    });
}
