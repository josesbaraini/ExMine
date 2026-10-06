import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the UI on :5173 and proxies /api to the Bun backend on :3000.
// In the container the backend serves both from one process (no proxy needed).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});