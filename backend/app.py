import json
from pathlib import Path
import secrets
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from backend.config import get_settings
from backend.provider import ProviderError, stream_chat

ROOT = Path(__file__).resolve().parent.parent
app = FastAPI(title="General Purpose AI Agent", version="0.1.0")
app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
bearer = HTTPBearer(auto_error=False)


@app.on_event("startup")
async def require_public_site_password() -> None:
    settings = get_settings()
    if settings.environment.lower() == "production" and len(settings.app_access_password.get_secret_value()) < 14:
        raise RuntimeError("Set APP_ACCESS_PASSWORD to at least 14 characters before public deployment.")


def check_site_password(credentials: HTTPAuthorizationCredentials | None) -> None:
    expected = get_settings().app_access_password.get_secret_value()
    if not expected:
        return
    if credentials is None or not secrets.compare_digest(credentials.credentials, expected):
        raise HTTPException(status_code=401, detail="Incorrect or missing website password.")


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)

    @field_validator("content")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message cannot be blank")
        return value


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "frontend" / "index.html")


@app.get("/api/health")
async def health() -> dict[str, str | bool]:
    settings = get_settings()
    return {
        "status": "ok",
        "model_configured": bool(settings.llm_api_key.get_secret_value()),
        "model": settings.llm_model,
        "access_required": bool(settings.app_access_password.get_secret_value()),
    }


@app.post("/api/chat/stream")
async def chat_stream(
    request: ChatRequest,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> StreamingResponse:
    check_site_password(credentials)
    settings = get_settings()
    if len(request.messages) > settings.max_input_messages:
        return _sse_error("Too many messages. Start a new conversation or remove older messages.", 400)
    if any(len(message.content) > settings.max_message_chars for message in request.messages):
        return _sse_error("A message is too long. Shorten it and try again.", 400)

    async def events():
        try:
            async for text in stream_chat(settings, [message.model_dump() for message in request.messages]):
                yield _sse("delta", {"text": text})
            yield _sse("done", {})
        except ProviderError as exc:
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _sse_error(message: str, status: int) -> StreamingResponse:
    return StreamingResponse(iter([_sse("error", {"message": message})]), status_code=status, media_type="text/event-stream")
