"""The HTTP API from PROTOCOL.md as a FastAPI router, for the React and Vue
inbox components.

    app.include_router(approvals_router(approvals, get_user=current_user), prefix="/api/approvals")

``get_user(request)`` returns ``{"id", "name"?, "avatar"?}`` or None; it may be async.
``can_review(user, record_or_none)`` decides who may review (default: everyone signed in).
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, Optional
from urllib.parse import parse_qs

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import ApprovalError, Approvals

__all__ = ["approvals_router"]


async def _call(fn: Callable, *args: Any) -> Any:
    value = fn(*args)
    return await value if inspect.isawaitable(value) else value


def _fail(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": code, "message": message}, status_code=status)


def approvals_router(
    approvals: Approvals,
    *,
    get_user: Callable[[Request], Any],
    can_review: Optional[Callable[[dict, Optional[dict]], Any]] = None,
) -> APIRouter:
    router = APIRouter()
    allowed = can_review or (lambda user, record: True)

    async def reviewer(request: Request) -> dict:
        user = await _call(get_user, request)
        if not user or user.get("id") is None:
            raise ApprovalError("unauthenticated", "Sign in to review approvals.", 401)
        return user

    async def load(request: Request, request_id: str) -> tuple[dict, dict]:
        user = await reviewer(request)
        record = await approvals.get(request_id)
        if not await _call(allowed, user, record):
            raise ApprovalError("forbidden", "You may not review this request.", 403)
        return user, record

    def name(user: dict) -> str:
        return str(user.get("name") or user["id"])

    def guarded(fn: Callable) -> Callable:
        @functools.wraps(fn)
        async def run(*args: Any, **kwargs: Any) -> Any:
            try:
                return await fn(*args, **kwargs)
            except ApprovalError as e:
                return _fail(e.status, e.code, str(e))

        return run

    @router.get("")
    @router.get("/")
    @guarded
    async def index(request: Request, status: str = "pending"):
        user = await reviewer(request)
        if not await _call(allowed, user, None):
            raise ApprovalError("forbidden", "You may not review approvals.", 403)
        if status not in ("pending", "done", "all"):
            raise ApprovalError("bad_request", "status is pending, done or all.", 400)
        rows = [r for r in await approvals.list(status) if await _call(allowed, user, r)]
        return {"data": rows}

    @router.post("/auth")
    @guarded
    async def auth(request: Request):
        user = await reviewer(request)
        if not await _call(allowed, user, None):
            raise ApprovalError("forbidden", "You may not review approvals.", 403)
        if "json" in request.headers.get("content-type", ""):
            body = await request.json()
        else:
            body = {k: v[0] for k, v in parse_qs((await request.body()).decode()).items()}
        result = approvals.authorize(str(body.get("socket_id", "")), str(body.get("channel_name", "")), user)
        return result if result else _fail(403, "forbidden", "Unknown channel.")

    @router.get("/{request_id}")
    @guarded
    async def show(request: Request, request_id: str):
        _, record = await load(request, request_id)
        return record

    @router.post("/{request_id}/decisions")
    @guarded
    async def decide(request: Request, request_id: str):
        user, _ = await load(request, request_id)
        body = await request.json()
        return await approvals.decide(request_id, body.get("decisions") or {}, by=name(user), send=body.get("send") is True)

    @router.delete("/{request_id}/decisions/{call_id}")
    @guarded
    async def undo(request: Request, request_id: str, call_id: str):
        user, _ = await load(request, request_id)
        return await approvals.undo(request_id, call_id, by=name(user))

    @router.post("/{request_id}/send")
    @guarded
    async def send(request: Request, request_id: str):
        user, _ = await load(request, request_id)
        return await approvals.send(request_id, by=name(user))

    @router.post("/{request_id}/retry")
    @guarded
    async def retry(request: Request, request_id: str):
        user, _ = await load(request, request_id)
        return await approvals.retry(request_id, by=name(user))

    return router
