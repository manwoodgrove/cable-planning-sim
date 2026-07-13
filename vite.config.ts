import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web-ifc's multithreaded WASM (and the Fragments worker) are happiest with
// cross-origin isolation enabled. These headers turn on SharedArrayBuffer.
export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    // web-ifc ships a big WASM; let Vite pre-bundle the thatOpen packages.
    exclude: ["web-ifc"],
  },
});
