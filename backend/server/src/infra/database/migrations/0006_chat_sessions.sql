CREATE TABLE "chat_budget" (
	"chat_id" uuid PRIMARY KEY NOT NULL,
	"token_limit" bigint NOT NULL,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_budget_limit_positive" CHECK ("chat_budget"."token_limit" > 0),
	CONSTRAINT "chat_budget_used_nonnegative" CHECK ("chat_budget"."tokens_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_context" (
	"chat_id" uuid PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"frozen_prompt" text DEFAULT '' NOT NULL,
	"prompt_hash" text DEFAULT '' NOT NULL,
	"summary_upto_seq" integer DEFAULT 0 NOT NULL,
	"topic_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_inbox" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'admitted' NOT NULL,
	"text" text NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	CONSTRAINT "chat_inbox_mode_check" CHECK ("chat_inbox"."mode" IN ('steer', 'followup')),
	CONSTRAINT "chat_inbox_state_check" CHECK ("chat_inbox"."state" IN ('admitted', 'promoted'))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"transcript_seq" integer,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cache_read" integer DEFAULT 0 NOT NULL,
	"tokens_cache_write" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_chat_seq" UNIQUE("chat_id","seq"),
	CONSTRAINT "chat_messages_seq_positive" CHECK ("chat_messages"."seq" > 0),
	CONSTRAINT "chat_messages_role_check" CHECK ("chat_messages"."role" IN ('user', 'assistant', 'system', 'summary')),
	CONSTRAINT "chat_messages_kind_check" CHECK ("chat_messages"."kind" IN ('steer', 'followup', 'suggestion', 'reply', 'notice', 'summary'))
);
--> statement-breakpoint
CREATE TABLE "chat_surfaced_terms" (
	"chat_id" uuid NOT NULL,
	"term_norm" text NOT NULL,
	"term" text NOT NULL,
	"first_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_surfaced_terms_chat_id_term_norm_pk" PRIMARY KEY("chat_id","term_norm")
);
--> statement-breakpoint
ALTER TABLE "chat_budget" ADD CONSTRAINT "chat_budget_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_context" ADD CONSTRAINT "chat_context_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_inbox" ADD CONSTRAINT "chat_inbox_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_surfaced_terms" ADD CONSTRAINT "chat_surfaced_terms_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_inbox_chat_state_idx" ON "chat_inbox" USING btree ("chat_id","state","admitted_at");--> statement-breakpoint
CREATE INDEX "chat_messages_chat_created_idx" ON "chat_messages" USING btree ("chat_id","created_at");