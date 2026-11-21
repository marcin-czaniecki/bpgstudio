import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {
    build: {
      // Sandbox preloads cannot resolve arbitrary runtime Node dependencies.
      externalizeDeps: false,
    },
  },
  renderer: {
    plugins: [react()],
  },
});
