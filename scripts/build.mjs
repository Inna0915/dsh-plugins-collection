import { build } from "esbuild";
import { mkdir, writeFile, copyFile, readdir } from "node:fs/promises";
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
    plugin: "src/dsh/plugin.ts",
    "test-exports": "src/test-exports.ts",
  },
  outdir: "dist",
});
const client = await build({
  entryPoints: ["src/client/dsh.tsx"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "cjs",
  external: ["react", "react-dom", "react/jsx-runtime"],
  write: false,
  loader: { ".css": "text" },
});
await writeFile(
  "dist/client.js",
  `window.__ModuleLoader__.load({id:"dsh-confluence-flow",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
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
  "Built CLI, DSH Host/Client, standalone document panel and test exports.",
);
