import type {
  MeetingChangedEvent,
  TranscriptResetEvent,
  TranscriptSegmentEvent,
  TranscriptStatusEvent,
} from '../../types/transcript';

/**
 * Main -> renderer push events for the followed meeting's transcript.
 * Shared type between the main-process sender and the renderer listener.
 */
export type TranscriptRendererHandlers = {
  onTranscriptSegment: (data: TranscriptSegmentEvent) => void;
  onTranscriptStatus: (data: TranscriptStatusEvent) => void;
  onTranscriptReset: (data: TranscriptResetEvent) => void;
  onMeetingChanged: (data: MeetingChangedEvent) => void;
  /** The operating system opened the app with a meeting link. */
  onInviteLink: (data: { token: string }) => void;
};
