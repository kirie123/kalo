import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tauri expects a fixed dev port and no console clearing
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  // Unit tests cover the pure logic only (folding, spec parsing, gate checks).
  // Anything that reaches Tauri IPC is not testable here and is not tested.
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
