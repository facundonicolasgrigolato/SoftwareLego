import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createLocalApiHandler } from "./server/localApiServer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function localSetsAndLDrawPlugin() {
  const attach = (server) => {
    const api = createLocalApiHandler({ rootDir: ROOT_DIR });
    server.middlewares.use(api.middleware);
    server.httpServer?.once("close", () => api.dispose());
  };
  return {
    name: "softwarelego-local-assets",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig({
  plugins: [localSetsAndLDrawPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-three": ["three"],
          "vendor-physics": ["cannon-es"],
          "vendor-net": ["peerjs"],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
