import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { claimKeyboardOnFocus } from './keyboard-claim';

// PWA : le service worker ne vit que sur http(s) (jamais sur `worklogs://` ni
// en dev, où il gênerait le rechargement). Chemin relatif : la portée suit le
// dossier d'hébergement, y compris un sous-dossier gh-pages.
if (import.meta.env.PROD && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Une vue Google invisible peut retenir le clavier du système : sans cette déclaration,
// taper dans un champ WorkLogs ne produit rien tant que la fenêtre n'a pas été réduite
// puis rouverte. Sans effet hors desktop (PWA, navigateur).
claimKeyboardOnFocus(window.worklogsDesktop?.googleDocs?.claimKeyboard);

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
