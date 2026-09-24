import os
import uuid
from datetime import UTC, datetime, timedelta

from dotenv import load_dotenv
from jose import jwt
import uuid
from uuid import UUID

load_dotenv()

SECRET: str = os.getenv("SECRET_KEY") or os.getenv("SESSION_SECRET", "")
ALGORITHM: str = os.getenv("ALGORITHM", "HS256")

if not SECRET:
    raise RuntimeError("SECRET_KEY or SESSION_SECRET must be configured")


def create_access_token(
    user_id: uuid.UUID, role: str, org_id: uuid.UUID, expiretime: int
) -> str:
    expire_at = datetime.now(UTC) + timedelta(minutes=expiretime)
    payload = {
        "sub": str(user_id),
        "role": role,
        "org_id": str(org_id),
        "exp": int(expire_at.timestamp()),
    }
    token = jwt.encode(payload, SECRET, algorithm=ALGORITHM)

    return token


def decode_access_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, SECRET, algorithms=[ALGORITHM])

        if payload and "sub" in payload:
            payload["user_id"] = payload["sub"]
        return payload
    except jwt.ExpiredSignatureError:
        print("DEBUG: Token has expired")
        return None
    except jwt.JWTError as e:
        print(f"DEBUG: JWT Error details: {str(e)}")
        return None
    except Exception as e:
        print(f"DEBUG: Unknown Error: {str(e)}")
        return None
