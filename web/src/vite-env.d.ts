/// <reference types="vite/client" />

declare const __WORKLOGS_VERSION__: string;

interface Window {
  worklogsDesktop?: {
    onBeforeClose: (callback: () => Promise<void>) => () => void;
    checkUpdatesNow?: () => Promise<string | null>;
    onUpdateProgress?: (
      callback: (payload: import('./components/UpdateBar').UpdateProgress) => void,
    ) => () => void;
  };
}
