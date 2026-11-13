/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** GIPHY API key used by the GIF search tab. */
  readonly VITE_GIPHY_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
