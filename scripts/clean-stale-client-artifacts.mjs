import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const staleDirectories = ["packages/client/src/components/layout/tracker-data-sidebar"];

let removedCount = 0;

for (const relativePath of staleDirectories) {
  const target = resolve(repoRoot, relativePath);

  if (!existsSync(target)) continue;

  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

  rmSync(target, { recursive: true, force: true });
  removedCount += 1;
  console.log(`[cleanup] Removed stale client artifact: ${relativePath}`);
}

if (removedCount === 0 && process.env.MARINARA_VERBOSE_CLEANUP === "true") {
  console.log("[cleanup] No stale client artifacts found.");
}
