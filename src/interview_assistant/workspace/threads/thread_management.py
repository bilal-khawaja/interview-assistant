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
    Workspace,
    User,
    ChatMessages,
    Threads,
)
from ...database.schema import (
    WorkspaceInput,
)
from ...authentication.jwt_validation.token import (
    get_current_user,
)
import uuid
from uuid import UUID

app = APIRouter()


@app.post("/create_thread")
async def create_thread(
    workspace_id: UUID | None = None,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):

    if workspace_id is not None:
        workspace_result = await session.exec(
            select(Workspace).where(
                Workspace.id == workspace_id,
                Workspace.organization_id == _current_user.org_id,
            )
        )
        workspace = workspace_result.first()

        if not workspace:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Workspace not found",
            )

    new_thread = Threads(
        workspace_id=workspace_id,
        user_id=_current_user.id,
        organization_id=_current_user.org_id,
    )
    session.add(new_thread)
    await session.commit()
    await session.refresh(new_thread)

    return {"thread_id": new_thread.id}


@app.get("/get_threads")
async def get_threads(
    workspace_id: UUID | None = None,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):

    if workspace_id is not None:
        workspace_result = await session.exec(
            select(Workspace).where(
                Workspace.id == workspace_id,
                Workspace.organization_id == _current_user.org_id,
            )
        )
        workspace = workspace_result.first()

        if not workspace:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Workspace not found",
            )
        threads_details = await session.exec(
            select(Threads).where(
                Threads.workspace_id == workspace_id,
                Threads.organization_id == _current_user.org_id,
                Threads.user_id == _current_user.id,
            )
        )
    else:
        threads_details = await session.exec(
            select(Threads).where(
                Threads.organization_id == _current_user.org_id,
                Threads.user_id == _current_user.id,
            )
        )
    threads = threads_details.all()

    return {"threads": threads}


@app.get("/get_thread")
async def get_thread(
    thread_id: UUID,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    thread_details = await session.exec(
        select(Threads).where(
            Threads.id == thread_id,
            Threads.user_id == _current_user.id,
            Threads.organization_id == _current_user.org_id,
        )
    )

    thread = thread_details.first()
    if not thread:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found",
        )

    return {"thread": thread}


@app.delete("/delete_thread")
async def delete_thread(
    thread_id: UUID,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    thread_details = await session.exec(
        select(Threads).where(Threads.id == thread_id)
    )

    thread = thread_details.first()
    if not thread:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found",
        )

    chat_messages_result = await session.exec(
        select(ChatMessages).where(ChatMessages.thread_id == thread_id)
    )
    for chat_message in chat_messages_result:
        await session.delete(chat_message)

    await session.delete(thread)
    await session.commit()

    return {"message": "Thread deleted successfully"}
