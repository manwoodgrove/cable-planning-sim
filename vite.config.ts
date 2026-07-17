import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Note: no COOP/COEP headers on purpose. Cross-origin isolation makes web-ifc
// pick its multithreaded build, whose Emscripten pthread workers can't locate
// their own script when bundled (new Worker("undefined")). The single-threaded
// build handles apartment-sized IFCs fine.
export default defineConfig({
  // ponytail: bind 0.0.0.0 so WSL2's IPv4 localhost-forward reaches the server.
  // Vite's default binds ::1 (IPv6) only, which Windows localhost:5173 can't hit.
  server: { host: true },
  plugins: [
    react(),
    // Serve the web-ifc WASM from our own origin instead of unpkg — works
    // offline and stays in lockstep with the installed package version.
    viteStaticCopy({
      targets: [
        { src: "node_modules/web-ifc/*.wasm", dest: "wasm", rename: { stripBase: true } },
      ],
    }),
  ],
  optimizeDeps: {
    // web-ifc ships a big WASM; let Vite pre-bundle the thatOpen packages.
    exclude: ["web-ifc"],
  },
});
