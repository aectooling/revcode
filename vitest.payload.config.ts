import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

const payload = process.env.REVCODE_TEST_PAYLOAD;
if (!payload) throw new Error("Set REVCODE_TEST_PAYLOAD to a staged release payload.");

// Reuse the host regressions against compiled files and their staged production
// dependencies, including real Pi SDK provider, image and authoring flows.
export default mergeConfig(base, defineConfig({
  resolve: {
    alias: [{
      find: /^\.\.\/\.\.\/src\/host\/(.+)\.js$/,
      replacement: `${resolve(payload).replaceAll("\\", "/")}/dist/host/$1.js`,
    }],
  },
}));
