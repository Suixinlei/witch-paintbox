import { defineConfig } from "vite";
import metadata from "./plugin.json" with { type: "json" };

export default defineConfig({
  build: {
    target: "es2022",
    lib: {
      entry: "src/main.ts",
      name: "RisuComfyImagePlugin",
      formats: ["iife"],
      fileName: () => "plugin.js",
    },
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        banner: `//@name ${metadata.name}\n//@display-name ${metadata.displayName}\n//@api ${metadata.api}\n//@version ${metadata.version}`,
      },
    },
  },
});
