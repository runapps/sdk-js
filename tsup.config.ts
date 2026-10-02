import { defineConfig } from "tsup";

// IIFE bundle for browser <script> tags.  Exposes window.RunApps
// as a constructor (alias for RunAppsClient) plus the namespace.
//
//   <script src="https://cdn.jsdelivr.net/npm/@runappsai/sdk/dist/sdk.umd.js"></script>
//   <script>
//     const client = new RunApps.Client({ authProvider: "runjobs" });
//   </script>
export default defineConfig({
  entry: { sdk: "src/index.ts" },
  format: ["iife"],
  globalName: "RunApps",
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
});
