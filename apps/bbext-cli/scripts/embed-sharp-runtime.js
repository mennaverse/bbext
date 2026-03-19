import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(projectRoot, "..", "..");
const bunNodeModulesRoot = resolve(workspaceRoot, "node_modules", ".bun", "node_modules");
const distDir = resolve(projectRoot, "dist");
const distNodeModules = resolve(distDir, "node_modules");

// Keep sharp external and copy the native runtime files it expects at runtime.
const runtimePackages = [
  "sharp",
  "detect-libc",
  "semver",
  "@img/colour",
  "@img/sharp-win32-x64",
];

async function copyRuntimePackage(packageName) {
  const source = resolve(bunNodeModulesRoot, packageName);
  const destination = resolve(distNodeModules, packageName);

  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

async function main() {
  await rm(distNodeModules, { recursive: true, force: true });
  await mkdir(distNodeModules, { recursive: true });

  for (const packageName of runtimePackages) {
    await copyRuntimePackage(packageName);
  }

  const distPackageJsonPath = resolve(distDir, "package.json");
  await writeFile(
    distPackageJsonPath,
    `${JSON.stringify({ name: "@bbext/cli-runtime", private: true }, null, 2)}\n`,
    "utf8",
  );

  console.log(`Sharp runtime embedded in ${distNodeModules}`);
}

await main();