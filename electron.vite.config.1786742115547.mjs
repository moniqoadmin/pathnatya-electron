// electron.vite.config.ts
import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
var electron_vite_config_default = defineConfig({
  main: {
    // readdirp is ESM-only, so bundle it into the CJS main output.
    plugins: [externalizeDepsPlugin({ exclude: ["readdirp"] })],
    build: {
      minify: "esbuild",
      sourcemap: false,
      rollupOptions: {
        output: {
          format: "cjs"
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: "esbuild",
      sourcemap: false
    }
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [react()],
    build: {
      minify: "esbuild",
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: void 0
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
