import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const clientDirectory = path.dirname(fileURLToPath(import.meta.url));

function captureRoute() {
  return {
    name: "capture-route",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url?.split("?")[0] === "/capture") request.url = `/capture.html${request.url.includes("?") ? `?${request.url.split("?")[1]}` : ""}`;
        next();
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(clientDirectory, ".."), "");
  let publicHost = null;
  try {
    if (env.PUBLIC_BASE_URL) publicHost = new URL(env.PUBLIC_BASE_URL).host;
  } catch {
    publicHost = null;
  }
  return {
    root: clientDirectory,
    envDir: path.resolve(clientDirectory, ".."),
    plugins: [captureRoute(), react()],
    build: {
      outDir: path.resolve(clientDirectory, "../dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          activity: path.resolve(clientDirectory, "index.html"),
          capture: path.resolve(clientDirectory, "capture.html")
        }
      }
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      allowedHosts: [
        ".trycloudflare.com",
        ".discordsays.com",
        ...(publicHost ? [publicHost] : [])
      ],
      proxy: {
        "/api": "http://127.0.0.1:3001",
        "/health": "http://127.0.0.1:3001",
        "/ws": { target: "ws://127.0.0.1:3001", ws: true }
      }
    },
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version || "dev"),
      "import.meta.env.VITE_DISCORD_CLIENT_ID": JSON.stringify(env.VITE_DISCORD_CLIENT_ID || env.DISCORD_CLIENT_ID || "")
    }
  };
});
