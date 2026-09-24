import asyncio
from pathlib import Path
from sqlmodel import select, func
import uuid
from uuid import UUID
from sqlmodel.ext.asyncio.session import AsyncSession
from ..database.db_setup import get_session
from ..database.models import Meeting, TranscriptLogs, ChatTranscriptCursor
from ..database.db_setup import async_session_maker
from fastapi import Depends


async def produce_transcripts(
    meeting_id: UUID,
    logs: str,
    seq: int,
    session: AsyncSession = Depends(get_session),
):

    transcript_logs = TranscriptLogs(
        meeting_id=meeting_id, transcript_text=logs, seq=seq
    )
    session.add(transcript_logs)
    await session.commit()

    return {"message": "Transcripts production initiated for the meeting."}


async def cursor_transcripts(
    meeting_id: UUID,
    chat_id: UUID,
    session: AsyncSession = Depends(get_session),
):

    cursor = await session.exec(
        select(ChatTranscriptCursor).where(
            ChatTranscriptCursor.meeting_id == meeting_id,
            ChatTranscriptCursor.chat_id == chat_id,
        )
    )
    cursor = cursor.first()

    logs = await session.exec(
        select(TranscriptLogs)
        .where(
            TranscriptLogs.meeting_id == meeting_id,
            TranscriptLogs.seq > cursor.last_seen_seq if cursor else 0,
        )
        .order_by(TranscriptLogs.seq, TranscriptLogs.created_at.desc())
    )
    logs = logs.all()

    if not logs:
        print(
            f"No new transcripts found for meeting {meeting_id} beyond seq {cursor.last_seen_seq if cursor else 0}."
        )
        return []

    cursor.last_seen_seq = (
        logs[-1].seq if logs else cursor.last_seen_seq if cursor else 0
    )
    await session.commit()

    return {"logs": logs}


async def chat_transcripts_context(
    meeting_id: UUID, query: str, session: AsyncSession = Depends(get_session)
):
    logs = await session.exec(
        select(TranscriptLogs)
        .where(
            TranscriptLogs.meeting_id == meeting_id,
            func.to_tsvector("english", TranscriptLogs.transcript_text).op(
                "@@"
            )(func.plainto_tsquery("english", query)),
        )
        .order_by(TranscriptLogs.seq)
    )

    logs = logs.all()

    if not logs:
        print(
            f"No transcripts found for meeting {meeting_id} matching the query '{query}'."
        )
        return []

    return logs
