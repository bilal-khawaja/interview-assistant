import { defineConfig } from "drizzle-kit";
import { env } from "./src/env";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/infra/database/schema.ts", "./src/db/schema"],
  out: "./src/infra/database/migrations",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
