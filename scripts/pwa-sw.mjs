// PWA WorkLogs : génère `sw.js` au build en y injectant la version racine.
// Le gabarit vit dans `web/src/sw-template.js`, la sortie part dans `web/dist/`.
export const SW_VERSION_PLACEHOLDER = '__WORKLOGS_VERSION__';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Remplace chaque occurrence du marqueur par la version, sans autre transformation. */
export function renderSw(template, version) {
  if (typeof template !== 'string' || !template.includes(SW_VERSION_PLACEHOLDER)) {
    throw new Error('Gabarit de service worker invalide : marqueur de version absent.');
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error('Version de service worker invalide.');
  }
  return template.split(SW_VERSION_PLACEHOLDER).join(version);
}

/** Lit la version du paquet racine depuis le texte de son `package.json`. */
export function readRootVersion(packageJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    throw new Error('package.json racine illisible.');
  }
  if (!parsed || typeof parsed.version !== 'string' || !VERSION_RE.test(parsed.version)) {
    throw new Error('Version du paquet racine invalide.');
  }
  return parsed.version;
}
