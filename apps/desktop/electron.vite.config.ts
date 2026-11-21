import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { PluginOption } from "vite";

const PG_NATIVE_SHIM = "\0pg-native-optional";

// pg lists pg-native as an optional peer. In dev, Vite replaces the missing
// module with a shim that throws while the bundle evaluates, so the main
// process dies on startup. The pure-JS client never loads the native binding.
const pgNativeOptional: PluginOption = {
  name: "pg-native-optional",
  enforce: "pre",
  resolveId(source) {
    if (source === "pg-native") return PG_NATIVE_SHIM;
    return null;
  },
  load(id) {
    if (id === PG_NATIVE_SHIM) return "export default {}";
    return null;
  },
};

export default defineConfig({
  main: {
    plugins: [pgNativeOptional],
  },
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
