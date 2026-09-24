import uuid
from pathlib import Path
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from ...authentication.jwt_validation.token import get_current_user
from ...database.db_setup import get_session
from ...database.models import (
    Document,
    OrganizationMember,
    User,
    Workspace,
    WorkspaceDocument,
    WorkspaceUserRelationship,
)
from ...database.schema import WorkspaceInput

app = APIRouter()


@app.post("/create_workspace")
async def create_workspace(
    data: WorkspaceInput,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    data.name = data.name.strip()
    user_details = await session.exec(
        select(User).where(User.id == _current_user.id)
    )

    user = user_details.first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    new_workspace = Workspace(
        name=data.name,
        organization_id=_current_user.org_id,
        system_prompt=data.system_prompt,
        model_provider=data.model_provider,
        model=data.model,
        temperature=data.temperature,
        history_limit=data.history_limit,
        top_n=data.top_n,
        similarity_threshold=data.similarity_threshold,
        chat_mode=data.chat_mode,
        vector_search_mode=data.vector_search_mode,
        query_refusal_response=data.query_refusal_response,
        created_by=_current_user.id,
    )
    session.add(new_workspace)
    await session.flush(new_workspace)

    # Add the current user as a member of the new workspace
    workspace_user_relationship = WorkspaceUserRelationship(
        workspace_id=new_workspace.id, user_id=_current_user.id
    )
    session.add(workspace_user_relationship)
    await session.commit()
    await session.refresh(new_workspace)
    return {
        "message": "Workspace created successfully",
        "workspace_id": new_workspace.id,
    }


@app.get("/get_workspaces")
async def get_workspaces(
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    org = await session.exec(
        select(OrganizationMember).where(
            OrganizationMember.user_id == _current_user.id,
            OrganizationMember.organization_id == _current_user.org_id,
        )
    )
    org = org.first()
    if not org:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization member not found",
        )

    result = await session.exec(
        select(Workspace)
        .join(
            WorkspaceUserRelationship,
            Workspace.id == WorkspaceUserRelationship.workspace_id,
        )
        .where(
            Workspace.organization_id == _current_user.org_id,
            WorkspaceUserRelationship.user_id == _current_user.id,
        )
    )

    workspaces = result.all()
    return {"workspaces": workspaces}


@app.delete("/delete_workspace")
async def delete_workspace(
    workspace_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    workspace_result = await session.exec(
        select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == _current_user.org_id,
            Workspace.created_by == _current_user.id,
        )
    )
    workspace = workspace_result.first()

    if not workspace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )

    # Delete associated WorkspaceUserRelationship entries
    workspace_user_relationships = await session.exec(
        select(WorkspaceUserRelationship).where(
            WorkspaceUserRelationship.workspace_id == workspace.id
        )
    )
    for wur in workspace_user_relationships:
        await session.delete(wur)

    # Delete associated WorkspaceDocument entries
    workspace_docs = await session.exec(
        select(WorkspaceDocument).where(
            WorkspaceDocument.workspace_id == workspace.id
        )
    )
    for wd in workspace_docs:
        await session.delete(wd)

    # Finally, delete the workspace itself
    await session.delete(workspace)
    await session.commit()

    return {"message": "Workspace deleted successfully"}


@app.put("/update_workspace_system_prompt")
async def update_workspace_system_prompt(
    workspace_id: UUID,
    system_prompt: str,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    workspace_result = await session.exec(
        select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == _current_user.org_id,
            Workspace.created_by == _current_user.id,
        )
    )
    workspace = workspace_result.first()

    if not workspace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )

    workspace.system_prompt = system_prompt
    await session.commit()
    await session.refresh(workspace)

    return {
        "message": "Workspace system prompt updated successfully",
        "workspace": workspace,
    }


@app.put("/configure_workspace_settings")
async def configure_workspace_settings(
    workspace_id: UUID,
    data: WorkspaceInput,
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    workspace_result = await session.exec(
        select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == _current_user.org_id,
            Workspace.created_by == _current_user.id,
        )
    )
    workspace = workspace_result.first()

    if not workspace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )

    # Update the workspace settings
    updates = data.model_dump(exclude_unset=True)

    for key, value in updates.items():
        if value is not None and value != "":
            setattr(workspace, key, value)

    await session.commit()
    await session.refresh(workspace)

    return {
        "message": "Workspace settings updated successfully",
        "workspace": workspace,
    }


# need to connected to graphRAG pipeline for the document to be stored as nodes in graphdb
@app.post("/upload_workspace_document")
async def upload_workspace_document(
    workspace_id: UUID,
    file: UploadFile = File(...),
    source: str = Form(...),
    session: AsyncSession = Depends(get_session),
    _current_user: User = Depends(get_current_user),
):
    workspace_result = await session.exec(
        select(Workspace).where(
            Workspace.id == workspace_id,
            Workspace.organization_id == _current_user.org_id,
            Workspace.created_by == _current_user.id,
        )
    )
    workspace = workspace_result.first()

    if not workspace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )

    document_name = Path(file.filename or "").name
    if not document_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded document must have a name",
        )

    source = source.strip()
    if not source:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Document source must not be empty",
        )

    document = Document(name=document_name, source=source)
    session.add(document)
    await session.flush()

    workspace_document = WorkspaceDocument(
        workspace_id=workspace.id,
        document_id=document.id,
    )
    session.add(workspace_document)
    await session.commit()

    return {
        "message": "Document registered successfully",
        "document_id": document.id,
    }
