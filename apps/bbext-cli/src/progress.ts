import type { ConvertProgress } from "@bbext/lib";
import type { JsonProgressLine } from "./types";

export function printJsonProgress(progress: ConvertProgress, prefix?: string): void {
  const payload: JsonProgressLine = {
    type: "progress",
    phase: progress.phase,
    totalModels: progress.totalModels,
    processedModels: progress.processedModels,
    source: progress.source,
    prefix,
  };

  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function printProgress(progress: ConvertProgress, prefix = ""): void {
  const tag = prefix.length > 0 ? `${prefix} ` : "";

  if (progress.phase === "model-processing") {
    const currentModel = progress.processedModels + 1;
    console.log(`${tag}Progress [model-processing] models ${currentModel}/${progress.totalModels} | source ${progress.source ?? "(unknown)"}`);
    return;
  }

  if (progress.phase === "model-completed") {
    console.log(`${tag}Progress [model-completed] models ${progress.processedModels}/${progress.totalModels} | source ${progress.source ?? "(unknown)"}`);
    return;
  }

  if (progress.phase === "done") {
    console.log(`${tag}Progress [done] models ${progress.totalModels}/${progress.totalModels}`);
  }
}
