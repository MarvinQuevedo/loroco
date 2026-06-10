import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Loroco dApp Console — Vite + React 19.
// base "/" because the app is served from a domain root (loroco.marvinquevedo.com).
// HashRouter handles in-app routing, so no server rewrites are strictly required.
export default defineConfig({
  plugins: [react()],
  base: "/",
  server: { port: 5174, strictPort: false },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
});
