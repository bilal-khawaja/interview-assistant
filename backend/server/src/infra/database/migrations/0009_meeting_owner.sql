-- Meetings had no owner before accounts existed; the old ones are test data and are dropped
-- (chats, segments, messages and participants go with them).
DELETE FROM "meetings";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_user_id_created_at_idx" ON "meetings" USING btree ("user_id","created_at");