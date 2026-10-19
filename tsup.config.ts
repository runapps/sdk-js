import { defineConfig } from "tsup";

// IIFE bundle for browser <script> tags.  Exposes window.RunApps
// as a constructor (alias for RunAppsClient) plus the namespace.
//
//   <script src="https://cdn.jsdelivr.net/npm/@runappsai/sdk/dist/sdk.umd.js"></script>
//   <script>
//     const client = new RunApps.Client({ authProvider: "runjobs" });
//   </script>
export default defineConfig([
// CommonJS build for Node projects that `require()` the package. tsc
// produces the ESM files; this is the same entry bundled as one .cjs
// (Node < 22.12 cannot require ESM, and bundlers resolving with the
// "require" condition need an entry for it).
{
  entry: { index: "src/index.ts" },
  format: ["cjs"],
  sourcemap: true,
  clean: false,
  target: "es2020",
  platform: "neutral",
  outExtension: () => ({ js: ".cjs" }),
},
{
  entry: { sdk: "src/index.ts" },
  format: ["iife"],
  globalName: "RunApps",
  // The served file says which release it is (https://www.runapps.ai/sdk/latest.js).
  banner: { js: `/* @runappsai/sdk ${process.env.npm_package_version ?? require("./package.json").version} */` },
  sourcemap: true,
  minify: true,
  clean: false, // tsc has already produced ESM; don't wipe it
  target: "es2020",
  platform: "browser",
  outExtension: () => ({ js: ".umd.js" }),
  // The IIFE leaves `RunApps` as the module namespace, so a script-tag
  // user writing `new RunApps({...})` — the form every doc shows — got
  // "not a constructor". Make the global the client class itself, with
  // the namespace's exports hung on it, so both `new RunApps(...)` and
  // `new RunApps.Client(...)` work.
  // `RunJobs` is kept as a second global for pages written before the rename.
  footer: { js: "RunApps = Object.assign(RunApps.Client, RunApps); var RunJobs = RunApps;" },
}]);
