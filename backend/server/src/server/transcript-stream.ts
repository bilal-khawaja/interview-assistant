import type { MeetingParticipantRepository } from "../db/repositories/participant.repository";
import type { SegmentRepository } from "../db/repositories/segment.repository";
import type { TranscriptSegment } from "../db/schema";
import { consume } from "../log/consume";
import { createRetrying } from "./db-retry";
import type { WakeHub } from "../log/wake";
import {
  CLOSE_CURSOR_AHEAD,
  CLOSE_INTERNAL_ERROR,
  CLOSE_SLOW_CONSUMER,
  type Frame,
  type SegmentFrame,
  type SpeakerInfo,
} from "./frames";

export type StreamSink = {
  send(frame: Frame): void;
  bufferedAmount(): number;
  close(code: number, reason: string): void;
};

export type StreamDeps = {
  segments: Pick<SegmentRepository, "head" | "readAfter">;
  participants: Pick<MeetingParticipantRepository, "listForMeeting">;
  hub: WakeHub;
  heartbeatMs: number;
  maxBufferedBytes: number;
  batchSize?: number;
  pollMs?: number;
  /** Backoff between reads while the database is unreachable. */
  retryBaseMs?: number;
  retryMaxMs?: number;
};

export async function runTranscriptStream(
  deps: StreamDeps,
  sink: StreamSink,
  meetingId: string,
  after: number,
  signal: AbortSignal,
): Promise<void> {
  let heartbeat: Timer | undefined;
  const retrying = createRetrying((frame) => sink.send(frame), signal, deps);

  try {
    const head = await deps.segments.head(meetingId);
    if (after > head) {
      sink.send({
        type: "error",
        code: "cursor_ahead",
        message: `after=${after} is beyond the log head ${head}`,
      });
      sink.close(CLOSE_CURSOR_AHEAD, "cursor ahead of head");
      return;
    }

    sink.send({
      type: "ready",
      stream: "transcript",
      meetingId,
      after,
      head,
      heartbeatMs: deps.heartbeatMs,
    });

    heartbeat = setInterval(() => {
      sink.send({ type: "heartbeat", at: new Date().toISOString() });
    }, deps.heartbeatMs);

    const batches = consume(
      {
        hub: deps.hub,
        readAfter: (m, cursor, limit) =>
          retrying(() => deps.segments.readAfter(m, cursor, limit), []),
        batchSize: deps.batchSize,
        pollMs: deps.pollMs,
      },
      meetingId,
      after,
      signal,
    );

    for await (const batch of batches) {
      const roster = await retrying(
        () => speakerRoster(deps, meetingId),
        new Map<string, SpeakerInfo>(),
      );
      if (signal.aborted) return;
      for (const segment of batch) {
        sink.send(segmentFrame(segment, roster));
      }
      if (sink.bufferedAmount() > deps.maxBufferedBytes) {
        sink.close(CLOSE_SLOW_CONSUMER, "slow consumer");
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    sink.send({
      type: "error",
      code: "internal",
      message: error instanceof Error ? error.message : "stream failed",
    });
    sink.close(CLOSE_INTERNAL_ERROR, "stream failed");
  } finally {
    clearInterval(heartbeat);
  }
}

async function speakerRoster(
  deps: StreamDeps,
  meetingId: string,
): Promise<Map<string, SpeakerInfo>> {
  const roster = new Map<string, SpeakerInfo>();
  for (const { participant, person } of await deps.participants.listForMeeting(meetingId)) {
    if (!participant.speakerKey) continue;
    roster.set(participant.speakerKey, {
      key: participant.speakerKey,
      participantId: participant.id,
      role: participant.role,
      label: participant.label,
      person: {
        id: person.id,
        fullName: person.fullName,
        organization: person.organization,
        jobTitle: person.jobTitle,
      },
    });
  }
  return roster;
}

function segmentFrame(
  segment: TranscriptSegment,
  roster: Map<string, SpeakerInfo>,
): SegmentFrame {
  return {
    type: "segment",
    seq: segment.seq,
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    source: segment.source,
    speakerKey: segment.speakerKey,
    speaker: segment.speakerKey ? (roster.get(segment.speakerKey) ?? null) : null,
    createdAt: segment.createdAt.toISOString(),
  };
}
