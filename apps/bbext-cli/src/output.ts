import type { JsonSummary } from "./types";

export function printJsonSummary(summary: JsonSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

export function printHumanSummary(summary: JsonSummary): void {
  if (summary.correct.length === 0 && summary.wrong.length === 0) {
    console.log("No files were exported.");
    console.log("Check your input path, filters/options, and use --overwrite if needed.");
    return;
  }

  console.log(`Conversion completed: ${summary.correct.length} success(es), ${summary.wrong.length} failure(s).`);
  for (const item of summary.correct) {
    const target = item.exported[0] ?? item.output;
    console.log(`- OK: ${item.model} -> ${target}`);
  }
  for (const item of summary.wrong) {
    console.log(`- FAIL: ${item.model} (${item.error ?? "unknown error"})`);
  }
}
