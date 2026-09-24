import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from interview_assistant.authentication.auth_api.auth_router import (
    router as auth_router,
)
from interview_assistant.users.handle_users import router as user_router
from interview_assistant.database.db_setup import init_db

load_dotenv()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    yield


app = FastAPI(lifespan=lifespan)


app.include_router(auth_router)
app.include_router(user_router)


@app.get("/")
def read_root() -> dict[str, str]:
    return {"message": "Interview Assistant API"}
