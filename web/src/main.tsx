import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// PWA : le service worker ne vit que sur http(s) (jamais sur `worklogs://` ni
// en dev, où il gênerait le rechargement). Chemin relatif : la portée suit le
// dossier d'hébergement, y compris un sous-dossier gh-pages.
if (import.meta.env.PROD && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
