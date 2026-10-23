export type SpeakerInfo = {
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
};

export type ReadyFrame = {
  type: "ready";
  stream: "transcript" | "chat";
  meetingId: string;
  /** Set on chat streams. */
  chatId?: string;
  after: number;
  head: number;
  heartbeatMs: number;
};

export type SegmentFrame = {
  type: "segment";
  seq: number;
  text: string;
  startMs: number;
  endMs: number;
  source: string;
  speakerKey: string | null;
  speaker: SpeakerInfo | null;
  createdAt: string;
};

/** One chat message, as stored. seq is gapless per chat, so a client resumes with ?after=<last seq>. */
export type MessageFrame = {
  type: "message";
  id: string;
  seq: number;
  role: string;
  kind: string;
  content: string;
  transcriptSeq: number | null;
  createdAt: string;
};

export type HeartbeatFrame = { type: "heartbeat"; at: string };

export type ErrorFrame = { type: "error"; code: string; message: string };

/** The server cannot read the log right now and is retrying. Segments resume after "recovered". */
export type DegradedFrame = { type: "degraded"; reason: string };

export type RecoveredFrame = { type: "recovered" };

export type Frame =
  | ReadyFrame
  | SegmentFrame
  | MessageFrame
  | HeartbeatFrame
  | ErrorFrame
  | DegradedFrame
  | RecoveredFrame;

export const CLOSE_CURSOR_AHEAD = 4409;
export const CLOSE_SLOW_CONSUMER = 1013;
export const CLOSE_INTERNAL_ERROR = 1011;
