import { DEFAULT_ASSET_PATH } from "../constants/media";
import { createInspection } from "../bootstrap/inspection";

async function main(): Promise<void> {
  const assetPath = process.argv[2] ?? DEFAULT_ASSET_PATH;
  const report = await createInspection().inspect(assetPath);

  console.log("\nAgent Final Response:\n", report.narrative);
  console.log("\nExtracted JSON Output:\n", JSON.stringify(report.findings, null, 2));
}

main().catch((error) => {
  console.error("Error running inspection:", error);
  process.exitCode = 1;
});
