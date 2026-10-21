CREATE FUNCTION "chat_messages_notify"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('chat_messages', chat_id::text)
  FROM (SELECT DISTINCT chat_id FROM new_rows) AS c;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_messages_notify_trg"
AFTER INSERT ON "chat_messages"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "chat_messages_notify"();
