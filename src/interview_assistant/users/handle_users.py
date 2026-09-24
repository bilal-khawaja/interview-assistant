import os

from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from ..database.db_setup import get_session
from ..database.models import (
    InvitationStatus,
    OrganizationMember,
    User,
    InvitationStatus,
    Invitation,
    InterviewStatus,
)
from ..database.schema import (
    RegistrationInput,
    UserPayload,
    UserRegistrationInput,
    UpdatePassword,
    UpdateUserRoleInput,
)
from ..email_sevice.email_setup import send_welcome_email
from ..authentication.jwt_validation.token import (
    check_hashed_password,
    hash_password,
    require_admin,
    get_current_user,
)
from ..authentication.jwt_validation.token_handeler import create_access_token
import uuid
from uuid import UUID
from datetime import UTC, datetime

load_dotenv()

router = APIRouter()


# for user creation and email invitation, only admin can create users
@router.post("/create_users")
async def create_users(
    user: UserRegistrationInput,
    session: AsyncSession = Depends(get_session),
    _current_user: UserPayload = Depends(require_admin),
):

    user.email = user.email.strip()
    user.name = user.name.strip()
    user.role = user.role.strip()
    user.password = user.password.strip()

    result = await session.exec(select(User).where(User.email == user.email))
    query = result.first()
    if query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    try:
        hashed_password = hash_password(user.password)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )

    create_user = User(
        name=user.name,
        email=user.email,
        password=hashed_password,
    )
    session.add(create_user)
    await session.flush()

    session.add(
        OrganizationMember(
            organization_id=_current_user.org_id,
            user_id=create_user.id,
            role=user.role,
        )
    )

    invite = Invitation(
        organization_id=_current_user.org_id,
        email=user.email,
        role=user.role,
        status=InvitationStatus.PENDING,
        created_at=datetime.now(UTC),
    )

    session.add(invite)
    await session.commit()

    await send_welcome_email(
        recipient=str(user.email),
        name=user.name,
        role=user.role,
    )

    return {"message": "User created"}


# Changging user password
@router.post("/change_password")
async def change_password(
    data: UpdatePassword,
    session: AsyncSession = Depends(get_session),
    current_user=Depends(get_current_user),
):
    check_user = await session.exec(
        select(User).where(User.id == current_user.sub)
    )
    user = check_user.first()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    if not check_hashed_password(data.old_password, user.password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Old password is incorrect",
        )

    try:
        hashed_password = hash_password(data.new_password)
        user.password = hashed_password
        await session.commit()
        return {"message": "Password changed successfully"}

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )


# User role handelling
@router.post("/update_user_role")
async def update_user_role(
    data: UpdateUserRoleInput,
    session: AsyncSession = Depends(get_session),
    current_user=Depends(require_admin),
):
    user_result = await session.exec(
        select(User).where(User.email == data.email)
    )
    user = user_result.first()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    membership_result = await session.exec(
        select(OrganizationMember).where(
            OrganizationMember.user_id == user.id,
            OrganizationMember.organization_id == current_user.org_id,
        )
    )
    membership = membership_result.first()
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User is not a member of this organization",
        )

    membership.role = data.new_role
    await session.commit()
    return {"message": "User role updated successfully"}


@router.get("/get_users")
async def get_users(
    session: AsyncSession = Depends(get_session),
    current_user=Depends(require_admin),
):
    result = await session.exec(
        select(User)
        .join(OrganizationMember)
        .where(OrganizationMember.organization_id == current_user.org_id)
    )
    users = result.all()

    return {"users": users}


@router.delete("/delete_user")
async def delete_user(
    user_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    current_user=Depends(require_admin),
):
    check_user = await session.exec(
        select(User)
        .join(OrganizationMember)
        .where(
            User.id == user_id,
            OrganizationMember.organization_id == current_user.org_id,
        )
    )
    user = check_user.first()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    membership_result = await session.exec(
        select(OrganizationMember).where(OrganizationMember.user_id == user.id)
    )
    for membership in membership_result.all():
        await session.delete(membership)
    await session.delete(user)
    await session.commit()
    return {"message": "User deleted successfully"}
