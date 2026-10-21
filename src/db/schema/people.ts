import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    email: text("email"),
    organization: text("organization"),
    jobTitle: text("job_title"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("people_email_unique").on(table.email)],
);

export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
