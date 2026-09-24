from ..database.models import Meeting, TranscriptLogs, ChatTranscriptCursor
from sqlmodel import select
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


# Since its a test file we use static dataset and therefore don't fetch teh recent saves instead we apply a limit of
# 10 to the query to fetch the last 10 transcripts for a given meeting_id and chat_id.
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


async def consume_transcripts(
    meeting_id: UUID, session: AsyncSession, chat_id: UUID
):
    # Fetch all transcripts for the given meeting_id

    chat = await session.exec(
        select(ChatTranscriptCursor).where(
            ChatTranscriptCursor.chat_id == chat_id
        )
    )
    chat = chat.first()
    if not chat:
        # Create a new cursor if it doesn't exist
        chat = ChatTranscriptCursor(last_seen_seq=0, chat_id=chat_id)
        session.add(chat)
        await session.flush()

    transcripts = await session.exec(
        select(TranscriptLogs)
        .where(
            TranscriptLogs.meeting_id == meeting_id,
            TranscriptLogs.seq > chat.last_seen_seq,
        )
        .order_by(TranscriptLogs.seq)
        .limit(10)
    )
    transcript_list = transcripts.all()

    if not transcript_list:
        print(
            f"No new transcripts found for meeting {meeting_id} beyond seq {chat.last_seen_seq}."
        )
        return

    chat.last_seen_seq = (
        transcript_list[-1].seq if transcript_list else chat.last_seen_seq
    )

    # Process each transcript (for demonstration, we'll just print them)
    for transcript in transcript_list:
        print(
            f"Processing Transcript Seq {transcript.seq}: {transcript.transcript_text}"
        )

    await session.commit()
    return transcript_list


async def main():

    async with async_session_maker() as session:
        logs = await consume_transcripts(
            meeting_id="661744bf-7e46-413f-a70d-15b5b92f1d8a",  # Replace with an actual UUID
            session=session,
            chat_id="37d6e461-7c3b-4249-8156-505614de657d",  # Replace with an actual UUID
        )

    context = "\n".join(f"Seq {log.seq}: {log.transcript_text}" for log in logs)

    # query = "What did they discuss about the authentication system?"

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are an interview assitant use the transcipt logs to suggest answers to any questions being asked or provide further insights on the topics being discussed or suggest questions to ask the interviewee based on the transcript logs.",
            },
            {
                "role": "user",
                "content": f"""

    Meeting Transcript Logs: 
    {context}


""",
            },
        ],
    )

    if response.choices:
        for choice in response.choices:
            print(
                "==========================================================Interview Assistant============================================================="
            )
            print(choice.message.content)
    if not response.choices:
        print("No responses generated.")


if __name__ == "__main__":
    asyncio.run(main())
