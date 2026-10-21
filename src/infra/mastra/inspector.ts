import { z } from "zod";
import type {
  InspectionAsset,
  InspectionReport,
} from "../../core/domain/inspection";
import { createMastra } from "../../mastra";
import { createInspectorAgent } from "../../mastra/agents";
import type * as Port from "../../core/ports";

const MAX_AGENT_STEPS = 5;

const findingsSchema = z.object({
  detectedObjects: z.array(z.string()),
  isCorrupted: z.boolean(),
  confidenceScore: z.number(),
});

export class Inspector implements Port.Inspector {
  async inspect(
    asset: InspectionAsset,
    journal: Port.Journal,
  ): Promise<InspectionReport> {
    const mastra = createMastra({
      agents: { inspector: createInspectorAgent(journal) },
    });
    try {
      const agent = mastra.getAgent("inspector");
      const kind = asset.extractedText !== undefined ? "document" : "image";

      const assessment = await agent.generate(
        [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Examine this ${kind}, evaluate its condition, and log the record using the logInspection tool.`,
              },
              { type: "file", data: asset.data, mediaType: asset.mediaType },
            ],
          },
        ],
        { maxSteps: MAX_AGENT_STEPS },
      );

      const content =
        asset.extractedText !== undefined
          ? [
              {
                type: "text" as const,
                text: `Parse this document into structured JSON. Use the extracted text below and do not invent details.\n\n${asset.extractedText}`,
              },
            ]
          : [
              {
                type: "text" as const,
                text: "Parse this image into structured JSON.",
              },
              {
                type: "file" as const,
                data: asset.data,
                mediaType: asset.mediaType,
              },
            ];
      const extraction = await agent.generate(
        [{ role: "user", content }],
        { structuredOutput: { schema: findingsSchema }, toolChoice: "none" },
      );

      return { narrative: assessment.text, findings: extraction.object };
    } finally {
      await mastra.observability?.flush?.();
      await mastra.shutdown();
    }
  }
}
