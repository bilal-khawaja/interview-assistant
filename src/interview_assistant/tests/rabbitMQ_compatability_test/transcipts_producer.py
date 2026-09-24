import json

from fastapi import APIRouter, Depends, HTTPException, status
import asyncio
from pathlib import Path
from sqlmodel import select
import uuid
from uuid import UUID
from sqlmodel.ext.asyncio.session import AsyncSession
from ...database.db_setup import get_session
from ...database.models import Meeting, TranscriptLogs
from ...database.db_setup import async_session_maker
import pandas as pd
import aio_pika

dataset_path = Path(__file__).resolve().parent.parent.parent / "dataset"
file = dataset_path / "test_df.csv"


def load_dataset():
    if not file.exists():
        raise FileNotFoundError(f"Dataset file not found at {file}")

    return pd.read_csv(file)


async def rbt_mq_producer(meeting_id: UUID, logs: str, seq: int):
    connection = await aio_pika.connect_robust("amqp://guest:guest@localhost/")
    async with connection:
        channel = await connection.channel()
        queue = await channel.declare_queue("transcripts_queue", durable=True)
        message_body = {"meeting_id": str(meeting_id), "logs": logs, "seq": seq}
        message = aio_pika.Message(
            body=json.dumps(message_body).encode(),
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        )
        await channel.default_exchange.publish(message, routing_key=queue.name)
        print(f"Sent message for meeting_id: {meeting_id}, seq: {seq}")


async def transcripts_subscriber(session: AsyncSession):
    connection = await aio_pika.connect_robust("amqp://guest:guest@localhost/")

    chanel = await connection.channel()
    queue = await chanel.declare_queue("transcripts_queue", durable=True)
    print("Waiting for messages...")

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            async with message.process():
                data = json.loads(message.body.decode())
                meeting_id = UUID(data["meeting_id"])
                logs = data["logs"]
                seq = data["seq"]

                transcript_log = TranscriptLogs(
                    meeting_id=meeting_id, logs=logs, seq=seq
                )
                session.add(transcript_log)
                await session.commit()
                print(
                    f"Processed message for meeting_id: {meeting_id}, seq: {seq}"
                )


def prepare_transcripts(df: pd.DataFrame):
    required_columns = {
        "Meeting_UID",
        "Transcript",
    }

    missing = required_columns - set(df.columns)

    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    df = df.dropna(subset=["Meeting_UID", "Transcript"]).copy()

    df["seq"] = range(1, len(df) + 1)

    meeting_id = uuid.uuid4()

    df["meeting_id"] = meeting_id

    return df


async def main():
    df = load_dataset()

    df = prepare_transcripts(df)
    # session.add(meeting)
    meeting_id = df["meeting_id"].iloc[0]

    async with async_session_maker() as session:
        meeting_details = Meeting(
            id=meeting_id,
        )
        session.add(meeting_details)
        await session.commit()

        subscriber_task = asyncio.create_task(transcripts_subscriber(session))

        try:
            await asyncio.sleep(1)  # Give the subscriber a moment to start

            for _, row in df.iterrows():
                await rbt_mq_producer(
                    meeting_id=row["meeting_id"],
                    logs=row["Transcript"],
                    seq=row["seq"],
                )

            await asyncio.sleep(
                2
            )  # Wait for a while to ensure all messages are processed
        finally:
            subscriber_task.cancel()
        try:
            await subscriber_task
        except asyncio.CancelledError:
            print("Subscriber task was cancelled.")


if __name__ == "__main__":
    asyncio.run(main())
