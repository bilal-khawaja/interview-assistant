import { count, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Executor } from "../client";

export type Row<T extends PgTable> = T["$inferSelect"];
export type NewRow<T extends PgTable> = T["$inferInsert"];

export type FindOptions = {
  where?: SQL;
  orderBy?: SQL | PgColumn | (SQL | PgColumn)[];
  limit?: number;
};

export abstract class BaseRepository<TTable extends PgTable> {
  constructor(
    protected readonly db: Executor,
    protected readonly table: TTable,
  ) {}

  withExecutor(executor: Executor): this {
    const Ctor = this.constructor as new (db: Executor) => this;
    return new Ctor(executor);
  }

  async findMany(options: FindOptions = {}): Promise<Row<TTable>[]> {
    let query = this.db.select().from(this.table as PgTable).$dynamic();
    if (options.where) query = query.where(options.where);
    if (options.orderBy !== undefined) {
      const order = Array.isArray(options.orderBy)
        ? options.orderBy
        : [options.orderBy];
      query = query.orderBy(...order);
    }
    if (options.limit !== undefined) query = query.limit(options.limit);
    return (await query) as Row<TTable>[];
  }

  async findOne(where: SQL): Promise<Row<TTable> | null> {
    const rows = await this.findMany({ where, limit: 1 });
    return rows[0] ?? null;
  }

  async exists(where: SQL): Promise<boolean> {
    return (await this.findOne(where)) !== null;
  }

  async count(where?: SQL): Promise<number> {
    const query = this.db
      .select({ value: count() })
      .from(this.table as PgTable)
      .$dynamic();
    const rows = await (where ? query.where(where) : query);
    return Number(rows[0]?.value ?? 0);
  }

  async insertOne(value: NewRow<TTable>): Promise<Row<TTable>> {
    const rows = await this.insertMany([value]);
    const row = rows[0];
    if (!row) throw new Error(`insert into ${this.tableName()} returned no row`);
    return row;
  }

  async insertMany(values: NewRow<TTable>[]): Promise<Row<TTable>[]> {
    if (values.length === 0) return [];
    return (await this.db
      .insert(this.table)
      .values(values as never)
      .returning()) as Row<TTable>[];
  }

  async insertIgnore(
    values: NewRow<TTable>[],
    target?: PgColumn[],
  ): Promise<Row<TTable>[]> {
    if (values.length === 0) return [];
    const query = this.db.insert(this.table).values(values as never);
    const rows = await (target
      ? query.onConflictDoNothing({ target })
      : query.onConflictDoNothing()
    ).returning();
    return rows as Row<TTable>[];
  }

  protected tableName(): string {
    return (this.table as unknown as { _: { name: string } })._.name;
  }
}

export abstract class MutableRepository<
  TTable extends PgTable,
> extends BaseRepository<TTable> {
  async updateWhere(
    where: SQL,
    set: Partial<NewRow<TTable>>,
  ): Promise<Row<TTable>[]> {
    return (await this.db
      .update(this.table)
      .set(set as never)
      .where(where)
      .returning()) as Row<TTable>[];
  }

  async deleteWhere(where: SQL): Promise<Row<TTable>[]> {
    return (await this.db
      .delete(this.table)
      .where(where)
      .returning()) as Row<TTable>[];
  }

  protected async upsert(
    value: NewRow<TTable>,
    target: PgColumn[],
    set: Record<string, SQL | unknown>,
  ): Promise<Row<TTable>> {
    const rows = (await this.db
      .insert(this.table)
      .values(value as never)
      .onConflictDoUpdate({ target, set: set as never })
      .returning()) as Row<TTable>[];
    const row = rows[0];
    if (!row) throw new Error(`upsert into ${this.tableName()} returned no row`);
    return row;
  }
}
