// Wire types shared with backend/server (src/server/frames.ts and meeting-routes.ts).
// Copied rather than imported so the Electron build never reaches into backend/.

export interface SpeakerInfo {
  key: string;
  participantId: string;
  role: string;
  label: string | null;
  person: {
    id: string;
    fullName: string;
    organization: string | null;
    jobTitle: string | null;
  };
}

export interface TranscriptSegment {
  seq: number;
  text: string;
  startMs: number;
  endMs: number;
  /** "gap" marks a stretch the transcriber could not hear (connection loss). */
  source: string;
  speakerKey: string | null;
  speaker: SpeakerInfo | null;
  createdAt: string;
}

export type MeetingStatus = 'created' | 'live' | 'ended';
export type MeetingSource = 'youtube' | 'live';
/** How the signed-in account relates to a meeting: it started it, or joined it through an invite link. */
export type MeetingRole = 'owner' | 'participant';

export interface Meeting {
  id: string;
  title: string;
  role: MeetingRole;
  status: MeetingStatus;
  /** What the meeting transcribes while it runs on the server, otherwise null. */
  source: MeetingSource | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export type StartMeetingInput =
  | { source: 'youtube'; url: string; title?: string; maxSeconds?: number }
  | { source: 'live'; title?: string };

/**
 * Connection state of a meeting's transcript stream.
 * - connecting: first connection attempt
 * - live: connected and receiving
 * - degraded: connected, but the server cannot read its database right now
 * - reconnecting: connection lost, retrying with the last sequence number
 * - ended: the meeting is over and everything was delivered
 * - removed: the owner took this account out of the meeting; nothing more arrives
 */
export type StreamStatus = 'connecting' | 'live' | 'degraded' | 'reconnecting' | 'ended' | 'removed';

export interface TranscriptStatusEvent {
  meetingId: string;
  status: StreamStatus;
  detail?: string;
}

export interface TranscriptSegmentEvent {
  meetingId: string;
  segment: TranscriptSegment;
}

/** The sequence restarted from zero (the server's log is behind the client's cursor); clear what you hold. */
export interface TranscriptResetEvent {
  meetingId: string;
}

export interface MeetingChangedEvent {
  meeting: Meeting;
}

/** A link the owner has made. The token itself is shown once, when it is created. */
export interface MeetingInvite {
  id: string;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
}

export interface CreatedInvite extends MeetingInvite {
  token: string;
  /** What to hand out: the app's join link with the token on the end. */
  url: string;
}

export interface CreateInviteInput {
  expiresInMinutes: number;
  maxUses?: number | null;
}

/** Someone in a meeting: the host first, then everyone who joined through a link. */
export interface MeetingMember {
  userId: string;
  name: string;
  /** Only the host is told other people's addresses. */
  email?: string;
  role: 'owner' | 'participant';
  joinedAt: string;
}

export type ApiResult<T> = ({ error?: undefined } & T) | { error: string; status?: number; meetingId?: string };
