export interface GoogleDocsBridge {
  open: (request: { documentId: string; tabId: string; token: string; bounds: { x: number; y: number; width: number; height: number } }) => Promise<{ phase: string; message: string }>;
  bounds: (request: { token: string; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }) => void;
  hide: (token: string) => void;
  close: (documentId: string) => Promise<boolean>;
  reload: (token: string) => Promise<void>;
  print: () => Promise<void>;
  onState: (callback: (state: { token: string; phase: string; message: string }) => void) => () => void;
}
