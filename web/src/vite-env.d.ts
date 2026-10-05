/// <reference types="vite/client" />

declare const __WORKLOGS_VERSION__: string;

interface Window {
  worklogsDesktop?: {
    googleDocs?: import('./google-desktop').GoogleDocsBridge;
    onBeforeClose: (callback: () => Promise<void>) => () => void;
    checkUpdatesNow?: () => Promise<string | null>;
    openAttachment?: (stored: string, filename: string) => Promise<string>;
    /** Dossier partagé : seul ce dialogue natif en fixe le chemin. */
    shared?: {
      chooseRoot: () => Promise<{ status?: import('./lib').SharedStatus; canceled?: boolean; error?: string }>;
      forgetRoot: () => Promise<{ status?: import('./lib').SharedStatus; error?: string }>;
      /** « Ouvrir avec… » le vrai fichier du partage : '' si l'application l'a pris, sinon le message. */
      openWith: (path: string) => Promise<string>;
    };
    onUpdateProgress?: (
      callback: (payload: import('./components/UpdateBar').UpdateProgress) => void,
    ) => () => void;
  };
}
