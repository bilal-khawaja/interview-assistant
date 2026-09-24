from ..transcripts.service import cursor_transcripts, chat_transcripts_context
from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from interview_assistant.authentication.jwt_validation.token import (
    get_current_user,
)
from ..database.db_setup import get_session
from ..authentication.jwt_validation.token import (
    get_current_user,
)
import uuid
from uuid import UUID


app = APIRouter()


# make the llm call here after retrieval of the context and return the response to the user.
@app.get("/transcripts_context/{meeting_id}")
async def get_cursor_transcripts(
    meeting_id: UUID,
    chat_id: UUID,
    session: AsyncSession = Depends(get_session),
    _current_user=Depends(get_current_user),
):
    result = await cursor_transcripts(meeting_id, chat_id, session)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No new transcripts found.",
        )
    return result
