import { printJsonSummary } from "./output";

export function fatalError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (process.argv.includes("--json")) {
    printJsonSummary({
      correct: [],
      wrong: [{
        model: "__cli__",
        output: "",
        exported: [],
        error: message,
      }],
    });
    process.exit(1);
  }

  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write("Use --help to see the available parameters.\n");
  process.exit(1);
}
