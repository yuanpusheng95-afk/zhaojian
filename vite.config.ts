import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "frontend",
  build: { outDir: "../dist/public", emptyOutDir: true },
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:3000",
      "/uploads": "http://127.0.0.1:3000",
      "/projects": "http://127.0.0.1:3000",
      "/generations": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
});
