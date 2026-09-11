/// <reference types="vite/client" />

interface Window {
  worklogsDesktop?: { onBeforeClose: (callback: () => Promise<void>) => () => void };
}
