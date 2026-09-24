import os
import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from dotenv import load_dotenv
import wave
from deepgram import AsyncDeepgramClient
from ..audio.wav_stream import WavAudioStream

load_dotenv()  

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
AUDIO_FILE_PATH = PACKAGE_ROOT / "dataset" / "ES2002a.Mix-Headset.wav"

class DeepgramTranscriber:

    def __init__(self):
        api_key = os.getenv("DEEPGRAM_API_KEY")
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY environment variable is not set.")
        
        self.client = AsyncDeepgramClient(api_key=api_key)


    async def stream(
                    self, 
                    audio_stream: AsyncIterator[bytes],
                    sample_rate : int = 16000,
                    channels : int = 1
            ):
        # Pass configuration dictionary directly to avoid import issues
        async with self.client.listen.v1.connect(
            model="nova-3",
            language="en-US",
            interim_results=True,
            smart_format=True,
            sample_rate=sample_rate,
            channels=channels,
            endpointing=300,
        ) as connection:

            # Start reading messages in a background task (without start_listening)
            receive_task = asyncio.create_task(
                self._consume_results(connection)
            )

            try:
                # Stream the binary audio chunks
                async for chunk in audio_stream:
                    await connection.send_media(chunk)

                # Signal end of audio stream
                await connection.send_finalize()
                
                # Give remaining messages time to flush before closing
                await asyncio.sleep(2)
            finally:
                receive_task.cancel()

    async def _consume_results(self, connection):
        try:
            # Iterate directly over connection without start_listening()
            async for message in connection:
                if hasattr(message, 'channel') and message.channel.alternatives:
                    transcript = message.channel.alternatives[0].transcript
                    if transcript:
                        print(f"Transcript: {transcript}")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"Consumer closed: {e}")

if __name__ == "__main__":

    async def main():
       
        wav = WavAudioStream(str(AUDIO_FILE_PATH))
        with wave.open(str(AUDIO_FILE_PATH), 'rb') as wav_file:
            sample_rate = wav_file.getframerate()
            channels = wav_file.getnchannels()
        deepgram = DeepgramTranscriber()
        await deepgram.stream(wav.stream(),
                              sample_rate=sample_rate,
                              channels=channels
                              )

    asyncio.run(main())