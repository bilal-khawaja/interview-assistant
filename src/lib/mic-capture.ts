import { PcmEncoder, rms } from './pcm';

export interface MicDevice {
  deviceId: string;
  label: string;
}

export interface MicCaptureOptions {
  /** A device from listMicrophones(); the system default when omitted. */
  deviceId?: string;
  /** 100 ms of 16 kHz mono PCM16, ready for the backend. */
  onChunk: (chunk: Uint8Array) => void;
  /** Input loudness, 0 to 1, about every 100 ms. */
  onLevel?: (level: number) => void;
  /** The microphone went away mid-meeting (unplugged, revoked, or taken by another app). */
  onEnded?: (reason: string) => void;
}

// A worklet runs on the audio thread and cannot import from the app bundle, so its few
// lines ship as a string. It only forwards raw samples; resampling and encoding happen
// in PcmEncoder, which the tests cover.
const WORKLET_SOURCE = `
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
`;

function audioInputs(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter((d) => d.kind === 'audioinput');
}

/**
 * Lists microphones, headsets included. Browsers hide device names until the page has had
 * microphone permission once, so when names are missing this asks briefly and lets go.
 */
export async function listMicrophones(): Promise<MicDevice[]> {
  let inputs = audioInputs(await navigator.mediaDevices.enumerateDevices());
  if (inputs.length > 0 && inputs.some((d) => !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      inputs = audioInputs(await navigator.mediaDevices.enumerateDevices());
    } catch {
      // Permission refused: fall through with unnamed devices.
    }
  }
  return inputs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

export function describeMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Allow it in your system privacy settings and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'That microphone is not available. Reconnect it or pick another one.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is in use by another app or could not be opened.';
    default:
      return error instanceof Error ? error.message : 'Could not start the microphone.';
  }
}

/** A running microphone capture. */
export class MicCapture {
  private stopped = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly nodes: AudioNode[],
  ) {}

  static async start(options: MicCaptureOptions): Promise<MicCapture> {
    const wanted = options.deviceId && options.deviceId !== 'default' ? { exact: options.deviceId } : undefined;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: wanted,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    let context: AudioContext;
    try {
      // Asking for 16 kHz lets the browser resample; fall back to the device rate if refused.
      context = new AudioContext({ sampleRate: 16_000 });
    } catch {
      context = new AudioContext();
    }

    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
      if (context.state === 'suspended') await context.resume();
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
      throw error;
    } finally {
      URL.revokeObjectURL(url);
    }

    const encoder = new PcmEncoder(context.sampleRate);
    const source = context.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(context, 'mic-tap');
    // Worklets only run while their output is connected somewhere; a silent gain keeps it
    // pulled without playing the microphone back through the speakers.
    const mute = context.createGain();
    mute.gain.value = 0;

    let levelAt = 0;
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const block = event.data;
      for (const chunk of encoder.push(block)) options.onChunk(chunk);
      const now = performance.now();
      if (options.onLevel && now - levelAt >= 100) {
        levelAt = now;
        options.onLevel(Math.min(1, rms(block) * 4));
      }
    };

    source.connect(tap);
    tap.connect(mute);
    mute.connect(context.destination);

    const capture = new MicCapture(stream, context, [source, tap, mute]);
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (!capture.stopped) options.onEnded?.('The microphone was disconnected.');
      };
    }
    return capture;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const track of this.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    for (const node of this.nodes) node.disconnect();
    void this.context.close();
  }
}
