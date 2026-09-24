import re

from pydantic import EmailStr, field_validator
from sqlmodel import SQLModel


class UserPayload(SQLModel):
    sub: str
    role: str
    org_id: str
    exp: int


class RegistrationInput(SQLModel):
    org_name: str
    org_email: EmailStr
    admin_name: str
    admin_email: EmailStr
    admin_password: str

    @field_validator("admin_password")
    @classmethod
    def password_must_be_strong(cls, p):
        if not re.search(
            r"^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%&*^_-])[A-Za-z\d!@#$%^&_*-]{5,}$",
            p,
        ):
            raise ValueError(
                "Password must be at least 5 characters long and contain: 1 uppercase letter, 1 lowercase letter, 1 digit, and 1 special character (!@#$%&*^_-)"
            )
        else:
            return p


class UserRegistrationInput(SQLModel):
    name: str
    email: EmailStr
    role: str
    password: str

    @field_validator("password")
    @classmethod
    def password_must_be_strong(cls, p):
        if not re.search(
            r"^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%&*^_-])[A-Za-z\d!@#$%^&_*-]{5,}$",
            p,
        ):
            raise ValueError(
                "Password must be at least 5 characters long and contain: 1 uppercase letter, 1 lowercase letter, 1 digit, and 1 special character (!@#$%&*^_-)"
            )
        else:
            return p


class UpdatePassword(SQLModel):
    old_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_must_be_strong(cls, p):
        if not re.search(
            r"^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%&*^_-])[A-Za-z\d!@#$%^&_*-]{5,}$",
            p,
        ):
            raise ValueError(
                "Password must be at least 5 characters long and contain: 1 uppercase letter, 1 lowercase letter, 1 digit, and 1 special character (!@#$%&*^_-)"
            )
        else:
            return p


class UpdateUserRoleInput(SQLModel):
    email: EmailStr
    new_role: str


class WorkspaceSetupInput(SQLModel):
    name: str
    system_prompt: str | None = None
    temperature: float | None = None
    history_limit: int | None = None
    top_n: int | None = None
    similarity_threshold: float | None = None
    model_provider: str | None = None
    chat_mode: str | None = None
    vector_search_mode: str | None = None
    model: str | None = None
    query_refusal_response: str | None = None
