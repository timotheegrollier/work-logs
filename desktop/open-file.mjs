import fs from 'node:fs';
import path from 'node:path';

/**
 * « Ouvrir avec… » : la pièce jointe est confiée à l'application par défaut du
 * système (LibreOffice pour un .ods…). On n'ouvre jamais le fichier du dossier
 * `uploads` lui-même : une modification enregistrée dessus divergerait en silence
 * de la copie Drive. On ouvre une **copie en lecture seule**, sous son vrai nom,
 * dans un dossier temporaire ; l'application prévient qu'il faut « Enregistrer sous ».
 */

// Ce que `xdg-open` pourrait exécuter ou installer au lieu d'afficher.
const REFUSED = new Set([
  'desktop', 'sh', 'bash', 'zsh', 'csh', 'fish', 'run', 'bin', 'appimage', 'exe', 'msi', 'bat', 'cmd', 'com',
  'jar', 'py', 'pyc', 'pl', 'rb', 'php', 'js', 'mjs', 'cjs', 'deb', 'rpm', 'flatpak', 'flatpakref', 'snap',
  'apk', 'command', 'x86_64', 'elf', 'so', 'ko',
]);

export function safeFilename(filename, fallback) {
  const cleaned = path.basename(String(filename || ''))
    .replace(/[\x00-\x1f\x7f/\\]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || fallback;
}

/** Prépare la copie à ouvrir et renvoie son chemin ; lève une erreur lisible sinon. */
export function prepareOpenCopy({ uploadDir, tmpDir, stored, filename }) {
  const storedName = path.basename(String(stored || ''));
  if (!storedName || storedName !== stored) throw new Error('Pièce jointe invalide.');
  const source = path.join(uploadDir, storedName);
  if (!fs.existsSync(source)) throw new Error('Fichier absent de cet ordinateur.');
  const name = safeFilename(filename, storedName);
  const extension = path.extname(name).slice(1).toLowerCase();
  if (REFUSED.has(extension) || REFUSED.has(path.extname(storedName).slice(1).toLowerCase())) {
    throw new Error(`Par sécurité, WorkLogs n’ouvre pas les fichiers .${extension || 'exécutables'} : télécharge-le si tu es sûr de lui.`);
  }
  // Un dossier par pièce jointe : deux fichiers du même nom ne s'écrasent pas.
  const folder = path.join(tmpDir, 'worklogs-open', storedName.replace(/\.[^.]*$/, ''));
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = path.join(folder, name);
  if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o400);
  return target;
}
