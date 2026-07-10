/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTROL_API_URL?: string;
  readonly VITE_CONTROL_API_TOKEN?: string;
}

interface Window {
  mlopsDesktop?: {
    apiToken?: string;
    platform: string;
    versions: {
      electron: string;
      chrome: string;
      node: string;
    };
  };
}
