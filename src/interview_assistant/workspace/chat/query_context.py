from ...transcripts.service import chat_transcripts_context
from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from interview_assistant.authentication.jwt_validation.token import (
    get_current_user,
)
from ...database.db_setup import get_session
from ...authentication.jwt_validation.token import (
    get_current_user,
)
import uuid
from uuid import UUID


app = APIRouter()


# make llm call here as well after retrieval of the context and return the response to the user.
@app.get("/transcripts_context/{meeting_id}")
async def get_chat_transcripts_context(
    meeting_id: UUID,
    query: str,
    session: AsyncSession = Depends(get_session),
    _current_user=Depends(get_current_user),
):
    result = await chat_transcripts_context(meeting_id, query, session)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No transcripts found for the given query.",
        )
    return result
