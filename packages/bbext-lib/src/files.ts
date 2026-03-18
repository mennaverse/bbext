import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

export async function ensureDirForFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function listBBModelsRecursive(inputPath: string): Promise<string[]> {
  const info = await stat(inputPath);
  if (info.isFile()) {
    return extname(inputPath).toLowerCase() === ".bbmodel" ? [inputPath] : [];
  }

  const results: string[] = [];
  const entries = await readdir(inputPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(inputPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await listBBModelsRecursive(fullPath);
      results.push(...nested);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".bbmodel") {
      results.push(fullPath);
    }
  }

  return results;
}
