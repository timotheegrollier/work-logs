import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { verifyRepo } from './verify-repo.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const version = '0.70.0';
const deb = `WorkLogs-${version}-linux-amd64.deb`;
const rpm = `WorkLogs-${version}-linux-x86_64.rpm`;

/** Réponses cohérentes d'un dépôt publié, avec de quoi simuler une panne. */
function fixture({ packagesVersion = version, releaseMismatch = false, rpmVersion = version, primaryMismatch = false } = {}) {
  const packages = `Package: worklogs\nVersion: ${packagesVersion}\nFilename: ./WorkLogs-${packagesVersion}-linux-amd64.deb\n\n`;
  const packagesBytes = Buffer.from(packages);
  const packagesGz = gzipSync(packagesBytes);
  const release = [
    'Origin: WorkLogs',
    'Suite: stable',
    'SHA256:',
    ` ${releaseMismatch ? '0'.repeat(64) : sha256(packagesBytes)} ${packagesBytes.length} Packages`,
    ` ${sha256(packagesGz)} ${packagesGz.length} Packages.gz`,
    '',
  ].join('\n');
  const primary = [
    '<metadata>',
    '<package type="rpm">',
    '<name>worklogs</name>',
    `<version epoch="0" ver="${rpmVersion}" rel="1"/>`,
    `<location href="${rpm}"/>`,
    `<checksum type="sha256" pkgid="YES">${sha256(Buffer.from('rpm'))}</checksum>`,
    '</package>',
    '</metadata>',
  ].join('');
  const primaryGz = gzipSync(Buffer.from(primary));
  const repomd = [
    '<repomd>',
    '<data type="primary">',
    `<checksum type="sha256">${primaryMismatch ? '0'.repeat(64) : sha256(primaryGz)}</checksum>`,
    '<location href="repodata/primary.xml.gz"/>',
    '</data>',
    '</repomd>',
  ].join('');

  return {
    '/deb/Packages': { body: packagesBytes },
    '/deb/Packages.gz': { body: packagesGz },
    '/deb/Release': { body: Buffer.from(release) },
    '/deb/worklogs.list': { body: Buffer.from('deb [trusted=yes] https://example.test/deb/ ./\n') },
    [`/deb/${deb}`]: { body: Buffer.from('deb-bytes') },
    '/rpm/repodata/repomd.xml': { body: Buffer.from(repomd) },
    '/rpm/repodata/primary.xml.gz': { body: primaryGz },
    '/rpm/worklogs.repo': { body: Buffer.from('[worklogs]\nbaseurl=https://example.test/rpm\n') },
    [`/rpm/${rpm}`]: { body: Buffer.from('rpm-bytes') },
  };
}

async function startServer(routes, onRequest = () => {}) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const override = onRequest(path, req);
    if (override) {
      res.writeHead(override.status, override.headers || {});
      res.end(override.body || undefined);
      return;
    }
    const route = routes[path];
    if (!route) {
      res.writeHead(404);
      res.end('introuvable');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': route.body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('accepte un dépôt cohérent et vérifie les deux formats', async () => {
  const depot = await startServer(fixture());
  try {
    const result = await verifyRepo({ tag: `v${version}`, baseUrl: depot.base, timeoutMs: 1000 });
    assert.equal(result.version, version);
    assert.deepEqual(result.checked, [`deb ${version}`, `rpm ${version}`]);
    assert.equal(result.attempts, 1);
  } finally {
    await depot.close();
  }
});

test('réessaie un 503 transitoire sur le .deb puis réussit', async () => {
  let failures = 2;
  const depot = await startServer(fixture(), (path, req) => {
    if (path === `/deb/${deb}` && req.method === 'HEAD' && failures > 0) {
      failures -= 1;
      return { status: 503, body: 'Service Unavailable' };
    }
    return null;
  });
  try {
    const result = await verifyRepo({
      tag: `v${version}`,
      baseUrl: depot.base,
      timeoutMs: 2000,
      intervalMs: 10,
      log: () => {},
    });
    assert.ok(result.attempts >= 3, `essais = ${result.attempts}`);
    assert.equal(failures, 0);
  } finally {
    await depot.close();
  }
});

test('échoue explicitement après le délai si le .deb reste indisponible', async () => {
  const depot = await startServer(fixture(), (path, req) =>
    path === `/deb/${deb}` && req.method === 'HEAD'
      ? { status: 503, body: 'Service Unavailable' }
      : null,
  );
  try {
    await assert.rejects(
      verifyRepo({ tag: `v${version}`, baseUrl: depot.base, timeoutMs: 80, intervalMs: 20, log: () => {} }),
      /Dépôts publics non prêts.*HTTP 503/,
    );
  } finally {
    await depot.close();
  }
});

test('refuse un index APT qui ne liste pas la version publiée', async () => {
  const depot = await startServer(fixture({ packagesVersion: '0.69.0' }));
  try {
    await assert.rejects(
      verifyRepo({ tag: `v${version}`, baseUrl: depot.base, timeoutMs: 50, intervalMs: 10, log: () => {} }),
      /Packages ne liste pas worklogs 0\.70\.0/,
    );
  } finally {
    await depot.close();
  }
});

test('refuse un Release dont l’empreinte ne correspond pas aux index', async () => {
  const depot = await startServer(fixture({ releaseMismatch: true }));
  try {
    await assert.rejects(
      verifyRepo({ tag: `v${version}`, baseUrl: depot.base, timeoutMs: 50, intervalMs: 10, log: () => {} }),
      /Release : empreinte de Packages incorrecte/,
    );
  } finally {
    await depot.close();
  }
});

test('refuse un index dnf qui ne liste pas la version publiée', async () => {
  const depot = await startServer(fixture({ rpmVersion: '0.69.0' }));
  try {
    await assert.rejects(
      verifyRepo({ tag: `v${version}`, baseUrl: depot.base, timeoutMs: 50, intervalMs: 10, log: () => {} }),
      /primary\.xml ne liste pas worklogs 0\.70\.0/,
    );
  } finally {
    await depot.close();
  }
});

test('refuse un primary.xml dont l’empreinte ne correspond pas à repomd.xml', async () => {
  const depot = await startServer(fixture({ primaryMismatch: true }));
  try {
    await assert.rejects(
      verifyRepo({ tag: `v${version}`, baseUrl: depot.base, timeoutMs: 50, intervalMs: 10, log: () => {} }),
      /repomd\.xml : empreinte du primary incorrecte/,
    );
  } finally {
    await depot.close();
  }
});

test('peut vérifier seulement le dépôt dnf quand le .deb a été sauté', async () => {
  const routes = fixture();
  for (const path of Object.keys(routes)) if (path.startsWith('/deb/')) delete routes[path];
  const depot = await startServer(routes);
  try {
    const result = await verifyRepo({
      tag: `v${version}`,
      baseUrl: depot.base,
      timeoutMs: 1000,
      skipDeb: true,
    });
    assert.deepEqual(result.checked, [`rpm ${version}`]);
  } finally {
    await depot.close();
  }
});
