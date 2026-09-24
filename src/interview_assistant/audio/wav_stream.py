import asyncio
import wave
from collections.abc import AsyncIterator

class WavAudioStream:
    def __init__(
            self,
            file_path: str,
            chunk_size: int = 4096,
            chunk_delay: float = 0.1,
    ):
        self.file_path = file_path
        self.chunk_size = chunk_size
        self.chunk_delay = chunk_delay


    async def stream(self) -> AsyncIterator[bytes]:
        with wave.open(self.file_path, 'rb') as wav_file:
            frames_sent = 0
            sample_width = wav_file.getsampwidth()
            num_channels = wav_file.getnchannels()
            sample_rate = wav_file.getframerate()

            if sample_width != 2:
                raise ValueError("WAV must use 16-bit PCM audio")

            if num_channels != 1:
                raise ValueError("WAV must be mono")
            frames_per_chunk = self.chunk_size // (sample_width * num_channels)
            loop = asyncio.get_running_loop()
            start_time = loop.time()

            while True:
                chunk = wav_file.readframes(frames_per_chunk)
                if not chunk:
                    break

                yield chunk

                frames_sent += len(chunk) // (sample_width * num_channels)
                target_time = start_time +(frames_sent / sample_rate)
                delay = target_time - loop.time()

                if delay > 0:
                    await asyncio.sleep(delay)