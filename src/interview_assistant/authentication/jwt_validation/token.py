from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext

from ...database.schema import UserPayload
from .token_handeler import decode_access_token

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str):
    return pwd.hash(password.strip())


def check_hashed_password(plain_pass: str, hashed_pass: str):
    return pwd.verify(plain_pass.strip(), hashed_pass)


class JWTBearer(HTTPBearer):
    def __init__(self, auto_error: bool = True):
        super().__init__(auto_error=auto_error)

    async def __call__(self, request: Request):
        credentials: HTTPAuthorizationCredentials = await super().__call__(
            request
        )
        if not credentials:
            raise HTTPException(
                status_code=403, detail="Invalid authorization code."
            )

        if credentials.scheme != "Bearer":
            raise HTTPException(
                status_code=403, detail="Invalid authentication scheme."
            )
        if not self.verify_jwt(credentials.credentials):
            raise HTTPException(
                status_code=403, detail="Invalid token or expired token."
            )
        return credentials.credentials

    def verify_jwt(self, jwtoken: str) -> bool:
        isTokenValid: bool = False
        try:
            payload = decode_access_token(jwtoken)
        except:
            payload = None
        if payload:
            isTokenValid = True
        return isTokenValid


async def get_current_user(token: str = Depends(JWTBearer())) -> UserPayload:
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=403, detail="Could not validate credentials"
        )

    return UserPayload(**payload)


async def require_admin(
    current_user: UserPayload = Depends(get_current_user),
) -> UserPayload:
    if current_user.role.lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    return current_user
