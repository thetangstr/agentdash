import { publicReleaseNotesPlugin } from "../scripts/docs/public-release-notes.mjs";
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [publicReleaseNotesPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
