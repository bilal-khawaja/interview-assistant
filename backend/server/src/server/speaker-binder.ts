import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { PersonRepository } from "../db/repositories/participant.repository";
import { meetingParticipants, user } from "../db/schema";

/** The key that tags segments from one account's microphone. */
export const userSpeakerKey = (userId: string) => `user:${userId}`;

/**
 * Gives a microphone owner a name in the transcript: a `people` row for the account and a
 * `meeting_participants` row that binds their `user:<id>` key to it, which is what the
 * transcript stream looks speakers up by.
 */
export class SpeakerBinder {
  constructor(private readonly db: Database) {}

  async bind(meetingId: string, userId: string, role: "host" | "participant"): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [account] = await tx.select().from(user).where(eq(user.id, userId)).limit(1);
      if (!account) return;
      const person = await new PersonRepository(tx).upsertByEmail({
        fullName: account.name,
        email: account.email,
      });
      await tx
        .insert(meetingParticipants)
        .values({ meetingId, personId: person.id, role, speakerKey: userSpeakerKey(userId) })
        .onConflictDoNothing();
    });
  }
}
