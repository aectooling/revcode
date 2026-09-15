#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// npm 12 rejects dashed flags after "--", so options are matched loosely:
// "npm run build:install -- open-revit" and "node scripts/build-install.mjs --open-revit" both work.
const ALIASES = {
  "open-revit": "OpenRevit",
  openrevit: "OpenRevit",
  "build-only": "BuildOnly",
  buildonly: "BuildOnly",
  help: "Help",
  h: "Help",
};

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const switches = new Set();
const years = [];
for (let index = 0; index < args.length; index++) {
  const token = args[index];
  const option = token.replace(/^-+/, "").toLowerCase();
  if (option === "revit-years" || option === "revityears") {
    const value = args[++index];
    if (!value?.trim()) {
      console.error("revit-years requires a comma-separated list of years.");
      process.exit(1);
    }
    years.push(...value.split(",").map((year) => year.trim()));
    continue;
  }
  const mapped = ALIASES[option];
  if (!mapped) {
    console.error(`Unknown option: ${token}`);
    process.exit(1);
  }
  switches.add(mapped);
}

if (switches.has("Help")) {
  console.log(`Usage: pnpm run build:install [options]

Build, verify, and install the local Revcode add-in for Revit.
Runs the production build, stages a versioned package with the bundled
Node runtime, and registers the per-user add-in. Close Revit first.

  open-revit              Open Revit after installation
  build-only              Build and verify the package without installing
  revit-years <list>      Revit versions to build, e.g. "revit-years 2025,2026"
  help                    Show this help

Options also work dashed when calling Node directly:
  node scripts/build-install.mjs --open-revit --revit-years 2025,2026`);
  process.exit(0);
}
if (switches.has("BuildOnly") && switches.has("OpenRevit")) {
  console.error("build-only cannot be combined with open-revit.");
  process.exit(1);
}

const commandArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./build-install.ps1", import.meta.url))];
if (switches.has("OpenRevit")) commandArgs.push("-OpenRevit");
if (switches.has("BuildOnly")) commandArgs.push("-BuildOnly");
if (years.length) {
  commandArgs.push("-RevitYears", years.join(","));
}

const result = spawnSync("powershell.exe", commandArgs, { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
