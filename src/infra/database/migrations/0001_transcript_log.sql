CREATE TABLE "chat_transcript_cursor" (
	"chat_id" uuid PRIMARY KEY NOT NULL,
	"last_seen_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transcript_segments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"speaker_key" text,
	"text" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"source" text DEFAULT 'stt' NOT NULL,
	"is_correction" boolean DEFAULT false NOT NULL,
	"corrects_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_segments_meeting_seq" UNIQUE("meeting_id","seq"),
	CONSTRAINT "transcript_segments_seq_positive" CHECK ("transcript_segments"."seq" > 0),
	CONSTRAINT "transcript_segments_time_order" CHECK ("transcript_segments"."end_ms" >= "transcript_segments"."start_ms"),
	CONSTRAINT "transcript_segments_correction_shape" CHECK (("transcript_segments"."is_correction" AND "transcript_segments"."corrects_seq" IS NOT NULL AND "transcript_segments"."corrects_seq" < "transcript_segments"."seq")
        OR (NOT "transcript_segments"."is_correction" AND "transcript_segments"."corrects_seq" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "chat_transcript_cursor" ADD CONSTRAINT "chat_transcript_cursor_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chats_meeting_idx" ON "chats" USING btree ("meeting_id");
--> statement-breakpoint
CREATE FUNCTION "transcript_segments_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transcript_segments is append-only (use a correction row)'
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "transcript_segments_no_update"
BEFORE UPDATE ON "transcript_segments"
FOR EACH ROW EXECUTE FUNCTION "transcript_segments_reject_update"();
--> statement-breakpoint
CREATE FUNCTION "transcript_segments_notify"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('transcript_segments', meeting_id::text)
  FROM (SELECT DISTINCT meeting_id FROM new_rows) AS m;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "transcript_segments_notify_trg"
AFTER INSERT ON "transcript_segments"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "transcript_segments_notify"();
