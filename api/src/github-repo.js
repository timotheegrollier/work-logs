/**
 * Dépôt GitHub relié à un projet, sous la forme `propriétaire/dépôt`. Module pur, partagé
 * avec la PWA (qui l'importe comme `project-folders.js`) : aucun appel réseau ici.
 */
const OWNER = /^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/;
const REPO = /^[\w.-]{1,100}$/;

export const GITHUB_REPO_MESSAGE = 'GitHub : saisis un dépôt sous la forme propriétaire/dépôt ou son lien https://github.com/…';

const invalid = () => Object.assign(new Error(GITHUB_REPO_MESSAGE), { status: 400, code: 'GITHUB_INVALID_REPO' });

/** `""`, `null` et `undefined` → null (projet sans dépôt). Un lien GitHub garde son dépôt seul. */
export function normalizeGithubRepo(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 300) throw invalid();
  const text = value.trim();
  if (!text) return null;
  let parts;
  if (/^https:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { throw invalid(); }
    if (url.hostname.toLowerCase() !== 'github.com') throw invalid();
    parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw invalid();
  } else {
    parts = text.replace(/\/$/, '').split('/');
    if (parts.length !== 2) throw invalid();
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || /^\.+$/.test(repo)) throw invalid();
  return `${owner}/${repo}`;
}
