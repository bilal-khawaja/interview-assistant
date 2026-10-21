export type SourceSegment = {
  text: string;
  startMs: number;
  endMs: number;
  speakerKey?: string | null;
  source?: string;
};

export interface TranscriptSource {
  stream(signal: AbortSignal): AsyncIterable<SourceSegment>;
}
