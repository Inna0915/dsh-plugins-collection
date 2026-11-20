import { build } from "esbuild";
import { mkdir, copyFile, readdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
for (const name of await readdir("skills")) {
  await mkdir(`skills/${name}/scripts`, { recursive: true });
  await copyFile("scripts/skill-run.mjs", `skills/${name}/scripts/run.mjs`);
}
const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  packages: "external",
  sourcemap: false,
};
await build({
  ...common,
  entryPoints: {
    cli: "src/cli.ts",
    "test-exports": "src/test-exports.ts",
  },
  outdir: "dist",
});
await build({
  entryPoints: ["src/client/standalone.tsx"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  outfile: "dist/standalone.js",
  loader: { ".css": "text" },
});
await copyFile("src/client/index.html", "dist/index.html");
console.log(
  "Built CLI, standalone document panel and test exports.",
);
