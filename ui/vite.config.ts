import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

// The production bundle is written straight into the Go server's embed directory, so `go build`
// after `pnpm build` produces one binary that serves both the API and the SPA.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: "../server/web/dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4100", changeOrigin: false },
      "/oauth2/redirect": { target: "http://127.0.0.1:4100" },
    },
  },
});
