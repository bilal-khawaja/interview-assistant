ALTER TABLE "transcript_segments" DROP CONSTRAINT "transcript_segments_correction_shape";--> statement-breakpoint
ALTER TABLE "transcript_segments" DROP COLUMN "is_correction";--> statement-breakpoint
ALTER TABLE "transcript_segments" DROP COLUMN "corrects_seq";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "transcript_segments_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transcript_segments is append-only'
    USING ERRCODE = 'restrict_violation';
END
$$;
