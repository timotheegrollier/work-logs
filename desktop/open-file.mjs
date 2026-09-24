import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

/**
 * Confie le fichier à l'application du système **sans attendre qu'elle se ferme**.
 * `shell.openPath` attend la fin de `xdg-open`, qui, selon le bureau, ne rend la
 * main qu'à la fermeture de LibreOffice : l'appel IPC restait alors sans réponse
 * (« reply was never sent »). Ici `xdg-open` part détaché ; on répond dès qu'il est
 * lancé. Absent (autre système, conteneur) : repli sur `fallback`, borné dans le temps.
 */
export function launchDetached(target, { command = 'xdg-open', spawnImpl = spawn, platform = process.platform, fallback = null, fallbackTimeoutMs = 5000, settleMs = 1500 } = {}) {
  const viaFallback = () => {
    if (!fallback) return Promise.resolve('aucun programme pour ouvrir les fichiers');
    // Un repli qui ne répond jamais vaut « lancé » : l'utilisateur voit l'application s'ouvrir ou non.
    return Promise.race([
      Promise.resolve().then(() => fallback(target)).then((failure) => failure || '', (error) => error?.message || String(error)),
      new Promise((resolve) => setTimeout(() => resolve(''), fallbackTimeoutMs)),
    ]);
  };
  if (platform !== 'linux') return viaFallback();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, [target], { detached: true, stdio: 'ignore' });
    } catch {
      resolve(viaFallback());
      return;
    }
    let done = false;
    const finish = (value) => { if (!done) { done = true; child.unref(); resolve(value); } };
    // Un échec immédiat (aucune application pour ce type) se voit au code de sortie ;
    // passé ce délai, l'application est lancée : on n'attend pas sa fermeture.
    child.once('spawn', () => setTimeout(() => finish(''), settleMs));
    child.once('exit', (code) => finish(code === 0 ? '' : `${command} a échoué, code ${code}`));
    child.once('error', () => { if (!done) { done = true; resolve(viaFallback()); } });
  });
}
