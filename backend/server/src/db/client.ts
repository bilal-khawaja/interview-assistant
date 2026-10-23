import { SQL as BunSQL } from "bun";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { env } from "../env";
import * as schema from "./schema";

export type Database = BunSQLDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Executor = Database | Transaction;

export type DbClient = {
  db: Database;
  sql: BunSQL;
  close(): Promise<void>;
};

export function createDb(databaseUrl: string = env.DATABASE_URL): DbClient {
  const sql = new BunSQL(databaseUrl);
  const db = drizzle<typeof schema, BunSQL>(sql, { schema });
  return { db, sql, close: () => sql.close() };
}
