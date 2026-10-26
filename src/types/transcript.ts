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

export interface Meeting {
  id: string;
  title: string;
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
 */
export type StreamStatus = 'connecting' | 'live' | 'degraded' | 'reconnecting' | 'ended';

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

export type ApiResult<T> = ({ error?: undefined } & T) | { error: string; status?: number; meetingId?: string };
