import uuid
from datetime import UTC, datetime
from enum import Enum
from uuid import UUID

from pydantic import EmailStr
from sqlmodel import Field, SQLModel, DateTime


class User(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(default=None, nullable=False)
    email: EmailStr = Field(default=None, nullable=False)
    password: str = Field(default=None, nullable=False)


class Organizations(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(unique=True, default=None, nullable=False)
    email: EmailStr = Field(unique=True, default=None, nullable=False)


class OrganizationMember(SQLModel, table=True):
    organization_id: UUID = Field(
        foreign_key="organizations.id",
        primary_key=True,
    )
    user_id: UUID = Field(
        foreign_key="user.id",
        primary_key=True,
    )
    role: str = Field(nullable=False)


class InvitationStatus(str, Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class Invitation(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    organization_id: UUID = Field(
        foreign_key="organizations.id", nullable=False
    )
    email: EmailStr = Field(nullable=False)
    role: str = Field(nullable=False)
    status: InvitationStatus = Field(
        default=InvitationStatus.PENDING, nullable=True
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC), nullable=False
    )
    invitation_url: str = Field(nullable=True)


class InterviewStatus(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class Meeting(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    status: InterviewStatus = Field(
        default=InterviewStatus.PENDING, nullable=False
    )
    organization_id: UUID = Field(
        foreign_key="organizations.id", nullable=False
    )


class Workspace(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    organization_id: UUID = Field(
        foreign_key="organizations.id", nullable=False
    )
    created_by: UUID = Field(foreign_key="user.id", nullable=False)
    name: str = Field(nullable=False, unique=True)
    # AI configuration
    system_prompt: str | None = Field(default=None)
    model_provider: str | None = Field(default=None)
    model: str | None = Field(default=None)
    temperature: float | None = Field(default=None)
    history_limit: int = Field(default=20)
    top_n: int = Field(default=4)
    similarity_threshold: float = Field(default=0.25)

    chat_mode: str = Field(default="chat")
    vector_search_mode: str = Field(default="default")
    query_refusal_response: str | None = Field(default=None)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        nullable=False,
    )

    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        nullable=False,
    )


class Threads(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="user.id", nullable=False)
    workspace_id: UUID | None = Field(
        default=None, foreign_key="workspace.id", nullable=True
    )
    organization_id: UUID = Field(
        foreign_key="organizations.id", nullable=False
    )
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(UTC), nullable=False
    )


class ChatMessages(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    thread_id: UUID | None = Field(
        default=None, foreign_key="threads.id", nullable=True
    )
    user_id: UUID = Field(foreign_key="user.id", nullable=False)
    query: str = Field(nullable=False)
    response: str = Field(nullable=False)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC), nullable=False
    )


class AppSettings(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    organization_id: UUID = Field(
        foreign_key="organizations.id", nullable=False
    )
    opacity: float = Field(default=1.0, nullable=False)


class TranscriptLogs(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    meeting_id: UUID = Field(foreign_key="meeting.id", nullable=False)
    seq: int = Field(nullable=False)
    transcript_text: str = Field(nullable=False)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_type=DateTime(timezone=True),
        nullable=False,
    )


class ChatTranscriptCursor(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    chat_id: UUID = Field(foreign_key="chatmessages.id", primary_key=True)

    last_seen_seq: int = Field(default=0, nullable=False)


class Memory(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="user.id", nullable=False)
    organization_id: UUID | None = Field(
        default=None,
        foreign_key="organizations.id",
        nullable=True,
    )
    workspace_id: UUID | None = Field(
        default=None,
        foreign_key="workspace.id",
        nullable=True,
    )
    chat_session_id: UUID | None = Field(
        default=None,
        foreign_key="threads.id",
        nullable=True,
    )
    content: str = Field(nullable=False)
    memory_type: str = Field(nullable=False)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC), nullable=False
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC), nullable=False
    )


class WorkspaceDocument(SQLModel, table=True):
    workspace_id: UUID = Field(
        foreign_key="workspace.id",
        primary_key=True,
    )
    document_id: UUID = Field(
        foreign_key="document.id",
        primary_key=True,
    )


class Document(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(nullable=False)
    source: str = Field(nullable=False)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC), nullable=False
    )


class WorkspaceUserRelationship(SQLModel, table=True):
    workspace_id: UUID = Field(
        foreign_key="workspace.id", primary_key=True, ondelete="CASCADE"
    )
    user_id: UUID = Field(
        foreign_key="user.id", primary_key=True, ondelete="CASCADE"
    )
