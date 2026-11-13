/** Build-time env values. Vite only exposes VITE_* variables to the client bundle. */

/** Built-in GIPHY API key for the optional GIF search tab (set VITE_GIPHY_API_KEY in .env). */
export const GIPHY_API_KEY: string = import.meta.env.VITE_GIPHY_API_KEY ?? "";
