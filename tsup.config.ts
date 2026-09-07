import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
