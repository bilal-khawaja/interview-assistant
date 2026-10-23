import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { PinoLogger } from "@mastra/loggers";
import {
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import { PostgresStore } from "@mastra/pg";
import { env } from "../env";

export type MastraComponents<
  A extends Record<string, Agent>,
  W extends Record<string, AnyWorkflow>,
> = { agents?: A; workflows?: W };

export function createMastra<
  const A extends Record<string, Agent> = Record<string, never>,
  const W extends Record<string, AnyWorkflow> = Record<string, never>,
>(components: MastraComponents<A, W>) {
  return new Mastra({
    ...components,
    storage: new PostgresStore({
      id: "mastra-storage",
      connectionString: env.DATABASE_URL,
      schemaName: "mastra",
    }),
    logger: new PinoLogger({ name: "vercelai", level: "warn" }),
    observability: new Observability({
      configs: {
        default: {
          serviceName: "vercelai",
          exporters: [new MastraStorageExporter()],
          spanOutputProcessors: [new SensitiveDataFilter()],
        },
      },
    }),
  });
}
