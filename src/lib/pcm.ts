/** What the backend's live-audio socket expects: 16 kHz, mono, 16-bit little-endian PCM. */
export const PCM_SAMPLE_RATE = 16_000;
/** 100 ms of audio per chunk sent to the backend. */
export const PCM_CHUNK_SAMPLES = 1_600;

/**
 * Turns the microphone's float samples (at whatever rate the audio device runs) into the
 * 16 kHz PCM16 chunks the backend wants. Resampling is linear interpolation, which is
 * plenty for speech recognition, and it carries its position across blocks so block
 * boundaries leave no clicks or drift.
 */
export class PcmEncoder {
  private readonly step: number;
  private out = new Int16Array(PCM_CHUNK_SAMPLES);
  private filled = 0;
  // Position of the next output sample, counted in input samples from the last sample of
  // the previous block (index 0). Starts at 1 so the first output is the first input.
  private phase = 1;
  private previous = 0;

  constructor(inputRate: number) {
    if (!(inputRate > 0)) throw new Error('input sample rate must be positive');
    this.step = inputRate / PCM_SAMPLE_RATE;
  }

  /** Feeds one block of samples in [-1, 1]; returns every full 100 ms chunk it completes. */
  push(block: Float32Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    const last = block.length;
    // The stream seen from here is [previous, ...block]: index 0 is the carried sample.
    const at = (i: number) => (i === 0 ? this.previous : block[i - 1]!);
    while (Math.floor(this.phase) + 1 <= last) {
      const i = Math.floor(this.phase);
      const frac = this.phase - i;
      this.write(at(i) * (1 - frac) + at(i + 1) * frac, chunks);
      this.phase += this.step;
    }
    if (last > 0) {
      this.phase -= last;
      this.previous = block[last - 1]!;
    }
    return chunks;
  }

  private write(sample: number, chunks: Uint8Array[]): void {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.out[this.filled++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    if (this.filled === PCM_CHUNK_SAMPLES) {
      // Int16Array is little-endian on every platform Electron runs on.
      chunks.push(new Uint8Array(this.out.buffer.slice(0)));
      this.out = new Int16Array(PCM_CHUNK_SAMPLES);
      this.filled = 0;
    }
  }
}

/** Root-mean-square level of a block, 0 to 1. */
export function rms(block: Float32Array): number {
  if (block.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
  return Math.sqrt(sum / block.length);
}
