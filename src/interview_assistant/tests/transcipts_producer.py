from fastapi import APIRouter, Depends, HTTPException, status
import asyncio
from pathlib import Path
from sqlmodel import select
import uuid
from uuid import UUID
from sqlmodel.ext.asyncio.session import AsyncSession
from ..database.db_setup import get_session
from ..database.models import Meeting, TranscriptLogs
from ..database.db_setup import async_session_maker
import pandas as pd
import aio_pika

dataset_path = Path(__file__).resolve().parent.parent / "dataset"
file = dataset_path / "test_df.csv"


def load_dataset():
    if not file.exists():
        raise FileNotFoundError(f"Dataset file not found at {file}")

    return pd.read_csv(file)


async def produce_transcipts(
    meeting_id: UUID,
    logs: str,
    seq: int,
    session: AsyncSession,
):
    # Fetch all meetings for the current user's organization

    transcript_logs = TranscriptLogs(
        meeting_id=meeting_id, transcript_text=logs, seq=seq
    )
    session.add(transcript_logs)
    await session.commit()

    return {"message": "Transcripts production initiated for all meetings."}


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

    print(f"Loaded {len(df)} transcript rows")
    print(f"Meetings: {df['Meeting_UID'].nunique()}")

    df = prepare_transcripts(df)
    # session.add(meeting)
    meeting_id = df["meeting_id"].iloc[0]

    async with async_session_maker() as session:
        meeting_details = Meeting(
            id=meeting_id,
        )
        session.add(meeting_details)
        await session.commit()

        for _, row in df.iterrows():
            await produce_transcipts(
                session=session,
                meeting_id=row["meeting_id"],
                logs=row["Transcript"],
                seq=row["seq"],
            )

    print(
        df[
            [
                "Meeting_UID",
                "meeting_id",
                "seq",
                "Transcript",
            ]
        ]
        .head(10)
        .to_string(index=False)
    )


if __name__ == "__main__":
    asyncio.run(main())
