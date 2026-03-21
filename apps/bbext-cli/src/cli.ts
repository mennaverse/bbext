import { parseArgs } from "./args";
import { runDefaultConversion, runManifestConversion } from "./conversion";
import { fatalError } from "./errors";
import { runGenerateManifest } from "./manifest";
import { printHumanSummary, printJsonSummary } from "./output";

process.on("uncaughtException", fatalError);
process.on("unhandledRejection", fatalError);

// Safety-net: force-quit after 5 minutes in case async handles keep the loop alive.
const forceExitTimer = setTimeout(() => {
  process.stderr.write("Error: Process timed out.\n");
  process.exit(1);
}, 5 * 60 * 1000);
forceExitTimer.unref();

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.generateManifest) {
      await runGenerateManifest(options);
      return;
    }

    const summary = options.manifestPath
      ? await runManifestConversion(options)
      : await runDefaultConversion(options);

    if (options.json) {
      printJsonSummary(summary);
      if (summary.wrong.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    printHumanSummary(summary);

    if (summary.wrong.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    fatalError(error);
  }
}

main().catch(fatalError);
