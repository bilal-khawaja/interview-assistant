from ..database.models import Meeting, TranscriptLogs, ChatTranscriptCursor

from sqlmodel import func, select
import asyncio
from sqlalchemy.ext.asyncio import AsyncSession
import uuid
from uuid import UUID
from ..database.db_setup import async_session_maker
import dotenv
from dotenv import load_dotenv
from openai import OpenAI
import os

load_dotenv()

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


async def llm_chat_context(meeting_id: UUID, session: AsyncSession, query: str):

    logs = await session.exec(
        select(TranscriptLogs)
        .where(
            TranscriptLogs.meeting_id == meeting_id,
            func.to_tsvector(
                "english",
                TranscriptLogs.transcript_text,  # Convert the transcript text to a tsvector, english gets rid of stop words and stemming
            ).op(
                "@@"  # operand @@ means does the tsvector match the tsquery
            )(
                func.plainto_tsquery(
                    "english",
                    query,  # Convert the query to a tsquery
                )
            ),
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


async def main():
    async with async_session_maker() as session:
        meeting_id = "661744bf-7e46-413f-a70d-15b5b92f1d8a"  # Replace with an actual meeting UUID
        query = "What did they discuss about Cesar Chavez?"

        logs = await llm_chat_context(meeting_id, session, query)

    context = "\n".join(
        [f"Seq: {log.seq}, Transcript: {log.transcript_text}" for log in logs]
    )

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant, your job is to respond to user's query based on the provided context.",
            },
            {
                "role": "user",
                "content": f"""
            Meeting Transcript Logs:
            {context}
            User Query: {query}""",
            },
        ],
    )
    if response.choices:
        for choice in response.choices:
            print(
                "==========================================================Interview Assistant Chatbot============================================================="
            )
            print(choice.message.content)
    if not response.choices:
        print("No responses generated.")


if __name__ == "__main__":
    asyncio.run(main())
