import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,

  build: {
    rollupOptions: {
      // Two pages, not one. The splash has to be on screen in the first few
      // milliseconds, so it gets an entry of its own rather than a route inside
      // the editor's bundle - see splash.html and src-tauri/src/splash.rs.
      input: {
        main: "index.html",
        splash: "splash.html",
      },
      output: {
        // Monaco is most of the bundle and changes only when it is upgraded.
        // Splitting it out lets the window paint without waiting for the whole
        // editor, and keeps it cached across releases of Aime itself.
        manualChunks: (id: string) => {
          // Vite's dynamic-import helper is shared, and Rollup parks it in
          // whichever chunk uses it most - Monaco. The entry then imports
          // 4.4 MB to get one function, undoing the split. Its own chunk
          // costs a few hundred bytes and keeps the editor off first paint.
          if (id.includes("vite/preload-helper")) return "preload";
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          return undefined;
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
