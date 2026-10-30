import { useSyncExternalStore } from 'react';
import { describeMicError, MicCapture } from './mic-capture';
import { tipcInvoker, transcriptHandlers } from './tipc-client';
import { TranscriptStore, type MeetingsState, type MicStarter, type TranscriptApi } from './transcript-store';

const t = tipcInvoker.transcript;

const api: TranscriptApi = {
  configure: (backendUrl) => t.transcriptConfigure({ backendUrl }),
  health: () => t.transcriptHealth(),
  list: () => t.meetingList(),
  active: () => t.meetingActive(),
  start: (input) => t.meetingStart(input),
  join: (token, speak) => t.meetingJoin({ token, speak }),
  leave: (meetingId) => t.meetingLeave({ meetingId }),
  end: (meetingId) => t.meetingEnd({ meetingId }),
  subscribe: (meetingId) => t.transcriptSubscribe({ meetingId }),
  unsubscribe: () => t.transcriptUnsubscribe(),
  sendAudio: (data) => t.meetingAudio({ data }),
  listen: (handlers) => {
    const stops = [
      transcriptHandlers.onTranscriptSegment.listen(handlers.onSegment),
      transcriptHandlers.onTranscriptStatus.listen(handlers.onStatus),
      transcriptHandlers.onTranscriptReset.listen(handlers.onReset),
      transcriptHandlers.onMeetingChanged.listen(handlers.onMeeting),
    ];
    return () => stops.forEach((stop) => stop());
  },
};

const mic: MicStarter = {
  start: (options) => MicCapture.start(options),
  describeError: describeMicError,
};

/** The one transcript store for this window. Meeting state outlives page navigation. */
export const transcriptStore = new TranscriptStore(api, mic, localStorage);

export function useMeetings(): MeetingsState {
  return useSyncExternalStore(transcriptStore.subscribe, transcriptStore.getState);
}
