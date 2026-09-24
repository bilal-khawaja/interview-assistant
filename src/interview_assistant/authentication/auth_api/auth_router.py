import os

from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from ...database.db_setup import get_session
from ...database.models import (
    OrganizationMember,
    Organizations,
    User,
    Invitation,
)
from ...database.schema import (
    RegistrationInput,
)
from ...email_sevice.email_setup import send_welcome_email
from ..jwt_validation.token import (
    check_hashed_password,
    hash_password,
    require_admin,
)
from ..jwt_validation.token_handeler import create_access_token

load_dotenv()

router = APIRouter()


@router.post("/register_organisation")
async def signup(
    org: RegistrationInput, session: AsyncSession = Depends(get_session)
):

    org.org_email = org.org_email.strip()
    org.admin_password = org.admin_password.strip()
    org.org_name = org.org_name.strip()
    org.admin_email = org.admin_email.strip()
    org.admin_name = org.admin_name.strip()

    query = await session.exec(
        select(Organizations).where(Organizations.email == org.org_email)
    )
    query = query.first()
    if query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    create = Organizations(name=org.org_name, email=org.org_email)

    session.add(create)
    await (
        session.flush()
    )  # Ensure the organization is added and its ID is generated

    try:
        hashed_password = hash_password(org.admin_password)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )

    create_user = User(
        name=org.admin_name,
        email=org.admin_email,
        password=hashed_password,
    )
    session.add(create_user)

    await session.flush()  # Ensure the user is added and its ID is generated

    org_member_rel = OrganizationMember(
        organization_id=create.id,
        user_id=create_user.id,
        role="admin",
    )
    session.add(org_member_rel)
    await session.commit()

    access_token = create_access_token(
        user_id=create_user.id,
        role=org_member_rel.role,
        org_id=create.id,
        expiretime=int(os.getenv("EXPIRES_IN_MINUTES", 120)),
    )
    return {
        "message": "Organization created",
        "access_token": access_token,
        "token_type": "bearer",
    }


@router.post("/signin")
async def signin(
    email: str = Body(...),
    password: str = Body(...),
    session: AsyncSession = Depends(get_session),
):

    query = await session.exec(select(User).where(User.email == email))
    query = query.first()

    if not query:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Wrong email: {email}",
        )

    if not check_hashed_password(password, query.password):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Invalid password"
        )

    membership_result = await session.exec(
        select(OrganizationMember).where(OrganizationMember.user_id == query.id)
    )
    membership = membership_result.first()
    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User is not a member of an organization",
        )

    access_token = create_access_token(
        user_id=query.id,
        role=membership.role,
        org_id=membership.organization_id,
        expiretime=int(os.getenv("EXPIRES_IN_MINUTES", 120)),
    )
    return {
        "message": "Login succesful",
        "access_token": access_token,
        "token_type": "bearer",
    }
