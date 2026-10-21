import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import {
  meetingParticipants,
  people,
  type MeetingParticipant,
  type NewPerson,
  type ParticipantRole,
  type Person,
} from "../schema";
import { MutableRepository } from "./base.repository";

export class PersonRepository extends MutableRepository<typeof people> {
  constructor(db: Executor) {
    super(db, people);
  }

  findByEmail(email: string): Promise<Person | null> {
    return this.findOne(eq(people.email, normalizeEmail(email)!));
  }

  create(input: Omit<NewPerson, "id" | "createdAt">): Promise<Person> {
    return this.insertOne({ ...input, email: normalizeEmail(input.email) });
  }

  upsertByEmail(
    input: Omit<NewPerson, "id" | "createdAt"> & { email: string },
  ): Promise<Person> {
    return this.upsert(
      { ...input, email: normalizeEmail(input.email) },
      [people.email],
      {
        fullName: sql`EXCLUDED.full_name`,
        organization: sql`COALESCE(EXCLUDED.organization, ${people.organization})`,
        jobTitle: sql`COALESCE(EXCLUDED.job_title, ${people.jobTitle})`,
        phone: sql`COALESCE(EXCLUDED.phone, ${people.phone})`,
      },
    );
  }
}

export type AddParticipantInput = {
  meetingId: string;
  personId: string;
  role: ParticipantRole;
  label?: string | null;
  speakerKey?: string | null;
};

export type ParticipantWithPerson = {
  participant: MeetingParticipant;
  person: Person;
};

export class MeetingParticipantRepository extends MutableRepository<
  typeof meetingParticipants
> {
  constructor(db: Executor) {
    super(db, meetingParticipants);
  }

  add(input: AddParticipantInput): Promise<MeetingParticipant> {
    return this.insertOne({
      meetingId: input.meetingId,
      personId: input.personId,
      role: input.role,
      label: input.label ?? null,
      speakerKey: input.speakerKey ?? null,
    });
  }

  async bindSpeaker(
    meetingId: string,
    participantId: string,
    speakerKey: string,
  ): Promise<MeetingParticipant | null> {
    const rows = await this.updateWhere(
      and(
        eq(meetingParticipants.meetingId, meetingId),
        eq(meetingParticipants.id, participantId),
      )!,
      { speakerKey },
    );
    return rows[0] ?? null;
  }

  findBySpeakerKey(
    meetingId: string,
    speakerKey: string,
  ): Promise<MeetingParticipant | null> {
    return this.findOne(
      and(
        eq(meetingParticipants.meetingId, meetingId),
        eq(meetingParticipants.speakerKey, speakerKey),
      )!,
    );
  }

  async listForMeeting(meetingId: string): Promise<ParticipantWithPerson[]> {
    const rows = await this.db
      .select({ participant: meetingParticipants, person: people })
      .from(meetingParticipants)
      .innerJoin(people, eq(people.id, meetingParticipants.personId))
      .where(eq(meetingParticipants.meetingId, meetingId))
      .orderBy(meetingParticipants.createdAt);
    return rows;
  }
}

function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}
