import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: '0.0.0.0', // Required for Docker
    port: 3000,
    strictPort: true,
    allowedHosts: [
      "dev.useautumn.com",
      "client.dev.useautumn.com",
      "localhost",
      // Allow ngrok (or similar) public URL      
      // Allow extra hosts via env (comma-separated)
      ...(process.env.VITE_ALLOWED_HOSTS
        ? process.env.VITE_ALLOWED_HOSTS.split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : []),
    ],
    watch: {
      usePolling: true, // Required for file watching in Docker on Windows
      interval: 1000,
    },
    hmr: {
      port: 3000,
    },
  },
});
