"""Human approvals for AI agents over Hibira realtime channels.

Python side of the Hibira approvals protocol (see PROTOCOL.md in the
repository): keep requests in a store, announce every change on the scope's
inbox channel, and resume the agent once reviewers have decided. The same
React and Vue inbox components work against it.

``pusher`` is a ``pusher.Pusher`` client pointed at Hibira, or any object with
the same ``trigger()`` and ``authenticate()`` methods.
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional, Protocol

__all__ = [
    "PROTOCOL_VERSION",
    "EVENT",
    "DECISIONS",
    "STATUSES",
    "ApprovalError",
    "Approvals",
    "MemoryStore",
    "Store",
    "approval_id",
    "inbox_channel",
    "reviewers_channel",
    "request_channel",
]

PROTOCOL_VERSION = 1
EVENT = "approval"
DECISIONS = ("approve", "reject", "edit")
STATUSES = ("pending", "approved", "rejected", "resuming", "resumed", "failed", "resolved", "expired")
_DONE = ["approved", "rejected", "resumed", "failed", "resolved", "expired"]
_SCOPE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_log = logging.getLogger("hibira_approvals")


def inbox_channel(scope: str) -> str:
    return f"private-hibira-approvals.{scope}.inbox"


def reviewers_channel(scope: str) -> str:
    return f"presence-hibira-approvals.{scope}.reviewers"


def request_channel(scope: str, request_id: str) -> str:
    return f"presence-hibira-approvals.{scope}.request.{request_id}"


class ApprovalError(Exception):
    """A request can't do that right now. ``status`` is the HTTP status to answer with."""

    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code = code
        self.status = status


_last = 0
_seq = 0


def _base36(n: int, width: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out.rjust(width, "0")


def approval_id() -> str:
    """Time-ordered ids, matching the JavaScript package."""
    global _last, _seq
    now = int(time.time() * 1000)
    _seq = _seq + 1 if now == _last else 0
    _last = now
    return "apr_" + _base36(now, 9) + _base36(_seq, 3) + secrets.token_hex(6)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


class Store(Protocol):
    """Where requests live. ``update`` must be atomic (a transaction with a row lock, Redis WATCH...)."""

    async def create(self, record: dict) -> dict: ...

    async def get(self, request_id: str) -> Optional[dict]: ...

    async def list(self, scope: str, statuses: Optional[list[str]], limit: int) -> list[dict]: ...

    async def update(self, request_id: str, fn: Callable[[dict], Optional[dict]]) -> Optional[dict]: ...


class MemoryStore:
    """Keeps requests in memory: fine for development and single-process apps."""

    def __init__(self) -> None:
        self._rows: dict[str, dict] = {}

    async def create(self, record: dict) -> dict:
        self._rows[record["id"]] = copy.deepcopy(record)
        return copy.deepcopy(record)

    async def get(self, request_id: str) -> Optional[dict]:
        row = self._rows.get(request_id)
        return copy.deepcopy(row) if row else None

    async def list(self, scope: str, statuses: Optional[list[str]], limit: int) -> list[dict]:
        rows = [r for r in self._rows.values() if r["scope"] == scope and (statuses is None or r["status"] in statuses)]
        rows.sort(key=lambda r: r["id"], reverse=True)
        return [copy.deepcopy(r) for r in rows[:limit]]

    async def update(self, request_id: str, fn: Callable[[dict], Optional[dict]]) -> Optional[dict]:
        row = self._rows.get(request_id)
        if row is None:
            return None
        nxt = fn(copy.deepcopy(row))
        if nxt is None:
            return None
        self._rows[request_id] = copy.deepcopy(nxt)
        return copy.deepcopy(nxt)


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class Approvals:
    """Requests for one scope.

    :param pusher: a ``pusher.Pusher`` client (or anything with ``trigger``/``authenticate``).
    :param resume: gives the agent its answers once every call is decided; may be async.
        Raising marks the request failed.
    :param notify: called after a request opens (push notifications, email, Slack...).
    :param url: returns a link to the request in your app.
    """

    def __init__(
        self,
        pusher: Any = None,
        *,
        scope: str = "default",
        store: Optional[Store] = None,
        resume: Optional[Callable[[dict], Any]] = None,
        notify: Optional[Callable[[dict], Any]] = None,
        url: Optional[Callable[[dict], Optional[str]]] = None,
        on_error: Optional[Callable[[BaseException], None]] = None,
    ) -> None:
        if not _SCOPE.match(scope):
            raise ValueError(f'Scope "{scope}" may only use letters, digits, - and _.')
        self.pusher = pusher
        self.scope = scope
        self.store: Store = store or MemoryStore()
        self._resume = resume
        self._notify = notify
        self._url = url
        self._on_error = on_error or (lambda e: _log.error("hibira-approvals: %s", e, exc_info=e))

    @property
    def inbox_channel(self) -> str:
        return inbox_channel(self.scope)

    @property
    def reviewers_channel(self) -> str:
        return reviewers_channel(self.scope)

    def request_channel(self, request_id: str) -> str:
        return request_channel(self.scope, request_id)

    async def _publish(self, record: dict, reason: str, by: Optional[str] = None) -> None:
        if self.pusher is None:
            return
        tools: list[str] = []
        for c in record["calls"]:
            if c["tool"] not in tools:
                tools.append(c["tool"])
        payload = {
            "v": PROTOCOL_VERSION,
            "id": record["id"],
            "reason": reason,
            "status": record["status"],
            "agent": record["agent"],
            "title": record["title"],
            "tools": tools,
            "by": by,
            "url": record["url"],
            "expires_at": record["expires_at"],
        }
        try:
            await asyncio.to_thread(self.pusher.trigger, self.inbox_channel, EVENT, payload)
        except Exception as e:  # noqa: BLE001 - announcing must never break the flow
            self._on_error(e)

    async def _load(self, request_id: str) -> dict:
        record = await self.store.get(request_id)
        if not record or record["scope"] != self.scope:
            raise ApprovalError("not_found", f"No approval request {request_id}.", 404)
        if record["status"] == "pending" and record["expires_at"] and _parse(record["expires_at"]) <= datetime.now(timezone.utc):

            def expire(r: dict) -> Optional[dict]:
                return {**r, "status": "expired", "finished_at": _now()} if r["status"] == "pending" else None

            expired = await self.store.update(request_id, expire)
            if expired:
                await self._publish(expired, "expired")
                return expired
            record = await self.store.get(request_id) or record
        return record

    @staticmethod
    def _pending_only(record: dict) -> None:
        if record["status"] != "pending":
            raise ApprovalError("not_pending", f"Request {record['id']} is {record['status']}.")

    async def _finish(self, request_id: str, by: Optional[str]) -> dict:
        record = await self.store.get(request_id)
        try:
            if self._resume is not None:
                await _maybe_await(self._resume(record))
        except Exception as e:  # noqa: BLE001
            self._on_error(e)
            message = str(e)[:2000]
            failed = await self.store.update(request_id, lambda r: {**r, "status": "failed", "finished_at": _now(), "error": message})
            await self._publish(failed, "failed", by)
            return failed
        done = await self.store.update(request_id, lambda r: {**r, "status": "resumed", "finished_at": _now(), "error": None})
        await self._publish(done, "resumed", by)
        return done

    async def request(
        self,
        calls: Iterable[dict],
        *,
        agent: str = "agent",
        title: Optional[str] = None,
        metadata: Optional[dict] = None,
        expires_in: Optional[timedelta] = None,
        id: Optional[str] = None,
    ) -> dict:
        """Opens a request for one or more tool calls ``{"id", "tool", "input"}`` and tells the reviewers."""
        calls = list(calls)
        if not calls:
            raise ValueError("request() needs at least one call.")
        items = []
        for i, c in enumerate(calls):
            if not isinstance(c.get("tool"), str):
                raise ValueError(f"Call {i} needs a tool name.")
            items.append(
                {
                    "id": str(c.get("id") or f"call_{i + 1}"),
                    "tool": c["tool"],
                    "input": c.get("input"),
                    "decision": None,
                    "edited_input": None,
                    "reason": None,
                    "decided_by": None,
                    "decided_at": None,
                }
            )
        if len({c["id"] for c in items}) != len(items):
            raise ValueError("Call ids must be unique.")
        record = {
            "id": id or approval_id(),
            "scope": self.scope,
            "agent": agent,
            "title": title,
            "status": "pending",
            "created_at": _now(),
            "expires_at": (datetime.now(timezone.utc) + expires_in).isoformat().replace("+00:00", "Z") if expires_in else None,
            "decided_at": None,
            "finished_at": None,
            "error": None,
            "url": None,
            "metadata": metadata or {},
            "calls": items,
        }
        record["url"] = self._url(record) if self._url else None
        saved = await self.store.create(record)
        await self._publish(saved, "requested")
        if self._notify:
            try:
                await _maybe_await(self._notify(saved))
            except Exception as e:  # noqa: BLE001
                self._on_error(e)
        return saved

    async def get(self, request_id: str) -> dict:
        return await self._load(request_id)

    async def list(self, status: str = "pending", limit: int = 50) -> list[dict]:
        statuses = None if status == "all" else _DONE if status == "done" else ["pending", "resuming"]
        return await self.store.list(self.scope, statuses, limit)

    async def decide(self, request_id: str, decisions: dict[str, dict], *, by: Optional[str] = None, send: bool = False) -> dict:
        """Saves decisions ``{call_id: {"decision", "input"?, "reason"?}}``. With ``send``, resumes once all are decided."""
        current = await self._load(request_id)
        self._pending_only(current)
        if not decisions:
            raise ApprovalError("bad_request", "No decisions given.", 400)
        ids = {c["id"] for c in current["calls"]}
        for call_id, d in decisions.items():
            if call_id not in ids:
                raise ApprovalError("bad_request", f"Unknown call {call_id}.", 400)
            if not isinstance(d, dict) or d.get("decision") not in DECISIONS:
                raise ApprovalError("bad_request", f'Unknown decision "{(d or {}).get("decision")}".', 400)
            if d["decision"] == "edit" and "input" not in d:
                raise ApprovalError("bad_request", "An edit needs the new input.", 400)
        at = _now()

        def apply(r: dict) -> Optional[dict]:
            if r["status"] != "pending":
                return None
            for c in r["calls"]:
                d = decisions.get(c["id"])
                if not d:
                    continue
                c["decision"] = d["decision"]
                c["edited_input"] = d.get("input") if d["decision"] == "edit" else None
                c["reason"] = str(d["reason"])[:2000] if d["decision"] == "reject" and d.get("reason") else None
                c["decided_by"] = by
                c["decided_at"] = at
            r["decided_at"] = at
            return r

        saved = await self.store.update(request_id, apply)
        if not saved:
            raise ApprovalError("not_pending", f"Request {request_id} is no longer pending.")
        await self._publish(saved, "decided", by)
        return await self.send(request_id, by=by) if send else saved

    async def undo(self, request_id: str, call_id: str, *, by: Optional[str] = None) -> dict:
        """Takes one decision back while the request still waits."""
        self._pending_only(await self._load(request_id))

        def clear(r: dict) -> Optional[dict]:
            if r["status"] != "pending":
                return None
            for c in r["calls"]:
                if c["id"] == call_id:
                    c.update(decision=None, edited_input=None, reason=None, decided_by=None, decided_at=None)
            return r

        saved = await self.store.update(request_id, clear)
        if not saved:
            raise ApprovalError("not_pending", f"Request {request_id} is no longer pending.")
        await self._publish(saved, "decided", by)
        return saved

    async def send(self, request_id: str, *, by: Optional[str] = None) -> dict:
        """Resumes the agent once every call is decided. Runs once."""
        current = await self._load(request_id)
        self._pending_only(current)
        if any(not c["decision"] for c in current["calls"]):
            raise ApprovalError("undecided", "Every call needs a decision first.")

        def claim(r: dict) -> Optional[dict]:
            ok = r["status"] == "pending" and all(c["decision"] for c in r["calls"])
            return {**r, "status": "resuming"} if ok else None

        claimed = await self.store.update(request_id, claim)
        if not claimed:
            raise ApprovalError("not_pending", f"Request {request_id} is no longer pending.")
        await self._publish(claimed, "resuming", by)
        return await self._finish(request_id, by)

    async def retry(self, request_id: str, *, by: Optional[str] = None) -> dict:
        """Resumes a failed request again."""
        await self._load(request_id)
        claimed = await self.store.update(request_id, lambda r: {**r, "status": "resuming", "error": None} if r["status"] == "failed" else None)
        if not claimed:
            raise ApprovalError("not_failed", f"Request {request_id} has not failed.")
        await self._publish(claimed, "resuming", by)
        return await self._finish(request_id, by)

    async def resolve(self, request_id: str) -> dict:
        """Marks a request as answered somewhere else, such as the app's own chat."""
        await self._load(request_id)
        saved = await self.store.update(
            request_id, lambda r: {**r, "status": "resolved", "finished_at": _now()} if r["status"] in ("pending", "failed") else None
        )
        if saved:
            await self._publish(saved, "resolved")
            return saved
        return await self._load(request_id)

    async def expire(self) -> int:
        """Expires overdue pending requests; run it from a scheduler if nobody opens them."""
        count = 0
        for r in await self.store.list(self.scope, ["pending"], 1000):
            if r["expires_at"] and _parse(r["expires_at"]) <= datetime.now(timezone.utc):
                if (await self._load(r["id"]))["status"] == "expired":
                    count += 1
        return count

    async def wait(self, request_id: str, *, interval: float = 1.0, timeout: Optional[float] = None) -> dict:
        """Polls until the request leaves ``pending``/``resuming``, for workers that wait in place."""
        deadline = time.monotonic() + timeout if timeout else None
        while True:
            r = await self._load(request_id)
            if r["status"] not in ("pending", "resuming"):
                return r
            if deadline and time.monotonic() >= deadline:
                raise ApprovalError("timeout", f"Timed out waiting for {request_id}.", 408)
            await asyncio.sleep(interval)

    def authorize(self, socket_id: str, channel: str, user: dict) -> Optional[dict]:
        """Pusher channel authorization for this scope's channels; None for any other channel."""
        ok = channel in (self.inbox_channel, self.reviewers_channel) or channel.startswith(
            f"presence-hibira-approvals.{self.scope}.request."
        )
        if not ok or self.pusher is None:
            return None
        if channel.startswith("presence-"):
            info = {"name": user.get("name") or str(user["id"])}
            if user.get("avatar"):
                info["avatar"] = user["avatar"]
            return self.pusher.authenticate(channel=channel, socket_id=socket_id, custom_data={"user_id": str(user["id"]), "user_info": info})
        return self.pusher.authenticate(channel=channel, socket_id=socket_id)
