import { SQL as BunSQL } from "bun";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { env } from "../../env";
import { documentChunks } from "./schema";

export type DatabaseSchema = {
  documentChunks: typeof documentChunks;
};

export type Database = BunSQLDatabase<DatabaseSchema>;

export type DatabaseClient = {
  db: Database;
  sql: BunSQL;
};

export function createDatabase(databaseUrl = env.DATABASE_URL): DatabaseClient {
  const sql = new BunSQL(databaseUrl);
  const db = drizzle<DatabaseSchema, BunSQL>(sql, {
    schema: { documentChunks },
  });

  return { db, sql };
}
