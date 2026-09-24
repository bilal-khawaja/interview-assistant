import os

from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from interview_assistant.authentication.jwt_validation.token import (
    get_current_user,
)

from ...database.db_setup import get_session
from ...database.models import (
    ChatMessages,
    ChatTranscriptCursor,
)

from ...authentication.jwt_validation.token import (
    get_current_user,
)
import uuid
from uuid import UUID


app = APIRouter()


@app.post("/create_chat_message")
async def create_chat_message(
    query: str,
    response: str,
    thread_id: UUID | None = None,
    session: AsyncSession = Depends(get_session),
    _current_user=Depends(get_current_user),
):

    new_chat_message = ChatMessages(
        chat_session_id=uuid.uuid4(),
        thread_id=thread_id,
        user_id=_current_user.id,
        query=query,
        response=response,
    )
    session.add(new_chat_message)
    await session.commit()
    await session.refresh(new_chat_message)

    return {
        "message": "Chat message created successfully",
        "chat_message": new_chat_message,
    }


@app.get("/get_chat_messages")
async def get_chat_messages(
    chat_id: UUID,
    thread_id: UUID | None = None,
    session: AsyncSession = Depends(get_session),
    _current_user=Depends(get_current_user),
):

    chat_messages_result = await session.exec(
        select(ChatMessages).where(
            ChatMessages.thread_id == thread_id,
            ChatMessages.id == chat_id,
            ChatMessages.user_id == _current_user.id,
        )
    )
    chat_messages = chat_messages_result.all()

    if not chat_messages:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No chat messages found for the specified thread.",
        )

    return {"chat_messages": chat_messages}


@app.delete("/delete_chat_message")
async def delete_chat_message(
    chat_message_id: UUID,
    session: AsyncSession = Depends(get_session),
    _current_user=Depends(get_current_user),
):

    chat_message_result = await session.exec(
        select(ChatMessages).where(
            ChatMessages.id == chat_message_id,
            ChatMessages.user_id == _current_user.id,
        )
    )
    chat_message = chat_message_result.first()

    if not chat_message:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chat message not found.",
        )

    await session.delete(chat_message)
    await session.commit()

    return {"message": "Chat message deleted successfully."}
