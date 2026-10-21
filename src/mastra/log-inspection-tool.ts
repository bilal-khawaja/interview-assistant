import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type * as Port from "../core/ports";

export function createLogInspectionTool(journal: Port.Journal) {
  return createTool({
    id: "logInspection",
    description: "Logs an issue or inspection record into the database",
    inputSchema: z.object({
      summary: z.string(),
      urgency: z.enum(["low", "medium", "high"]),
    }),
    execute: async (record) => ({
      status: "success",
      ...(await journal.append(record)),
    }),
  });
}
