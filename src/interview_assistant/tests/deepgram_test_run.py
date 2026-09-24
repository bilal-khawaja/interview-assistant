import asyncio
import os
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from deepgram import AsyncDeepgramClient
from deepgram.core.events import EventType

load_dotenv() 

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
AUDIO_FILE_PATH = PACKAGE_ROOT / "dataset" / "ES2002a.Mix-Headset.wav"

async def run_deepgram_stream_test(
    audio_file_path: str,
    api_key: Optional[str] = None,
    chunk_size: int = 1024 * 8,
    chunk_delay: float = 0.04
) -> bool:

    api_key = api_key or os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        raise ValueError("DEEPGRAM_API_KEY is not set.")

    if not os.path.exists(audio_file_path):
        raise FileNotFoundError(f"Audio file not found: {audio_file_path}")

    print(f"Pre-loading {audio_file_path} into memory...")
    with open(audio_file_path, "rb") as audio:
        audio.read(44)  # Skip the 44-byte WAV header cleanly
        audio_bytes = audio.read()

    # Pre-slice chunks into a list to prevent microsecond loop calculations
    audio_chunks = [audio_bytes[i:i + chunk_size] for i in range(0, len(audio_bytes),
                                                                  chunk_size) if audio_bytes[i:i + chunk_size]]

    client = AsyncDeepgramClient(api_key=api_key)

    try:
        async with client.listen.v1.connect(
            model="nova-3",
            language="en-US",
            smart_format=True,
            interim_results=False,
            encoding="linear16",
            sample_rate=16000,
            channels=1
        ) as dg_connection:

            def on_message(result, **kwargs):
                try:
                    if not hasattr(result, "channel") or not result.channel:
                        return
                    alternatives = result.channel.alternatives
                    sentence = alternatives.transcript
                    if sentence:
                        print(f"\n[Transcript]: {sentence}")
                except Exception as e:
                    print(f"\nParsing Error: {e}")

            def on_error(error, **kwargs):
                print(f"\nDeepgram Error Callback: {error}")

            dg_connection.on(EventType.MESSAGE, on_message)
            dg_connection.on(EventType.ERROR, on_error)
            
            # start listener
            await dg_connection.start_listening()

            # Stream audio chunks to Deepgram 
            print("Streaming audio chunks instantly...")
            for chunk in audio_chunks:
                await dg_connection.send_media(chunk)
                await asyncio.sleep(chunk_delay)

            
            await dg_connection.finish()
            print("\nStreaming finished successfully.")
            return True

    except Exception as e:
        print(f"Failed to complete WebSocket connection or stream: {e}")
        return False


if __name__ == "__main__":
    TEST_AUDIO = str(AUDIO_FILE_PATH)
    asyncio.run(run_deepgram_stream_test(TEST_AUDIO))
