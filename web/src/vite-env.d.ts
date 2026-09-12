/// <reference types="vite/client" />

declare const __WORKLOGS_VERSION__: string;

interface Window {
  worklogsDesktop?: {
    onBeforeClose: (callback: () => Promise<void>) => () => void;
    checkUpdatesNow?: () => Promise<string | null>;
  };
}
