import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  optimizeDeps: { force: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/release/**", "**/test-results/**"] },
  },
  build: { target: "chrome134", sourcemap: true, assetsInlineLimit: 0 },
  worker: { format: "es" },
});
