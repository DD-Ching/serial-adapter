#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const hasGitDir = existsSync(resolve(root, ".git"));
const hasHuskyPackage = existsSync(resolve(root, "node_modules", "husky"));
const npmExecPath = process.env.npm_execpath;

if (!hasGitDir) {
  console.log("[serial-adapter] prepare: skip husky (no .git directory).");
  process.exit(0);
}

if (!hasHuskyPackage || !npmExecPath) {
  console.log(
    "[serial-adapter] prepare: skip husky (dependency not installed yet)."
  );
  process.exit(0);
}

const gitCheck = spawnSync("git", ["--version"], { stdio: "ignore" });
if (gitCheck.error || gitCheck.status !== 0) {
  console.log("[serial-adapter] prepare: skip husky (git not in PATH).");
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [npmExecPath, "exec", "--no", "husky"],
  {
    cwd: root,
    stdio: "inherit",
  }
);
if (result.error || result.status !== 0) {
  const reason = result.error?.message ?? `exit_code=${result.status}`;
  console.log(`[serial-adapter] prepare: skip husky (${reason}).`);
}
