"""LangGraph: a node asks with ``interrupt(approval(tool, input))`` and gets
the reviewer's decision back when the graph resumes.

    calls, title = approval_calls(graph.invoke(inputs, config))
    req = await approvals.request(calls, title=title, metadata={"thread_id": ...})
    # once decided (inside Approvals(resume=...)):
    graph.invoke(Command(resume=resume_value(req)), config)
"""

from __future__ import annotations

from typing import Any, Optional

INTERRUPT_TYPE = "hibira-approval"

__all__ = ["INTERRUPT_TYPE", "approval", "approval_calls", "decision_for", "resume_value"]


def approval(tool: str, input: Any = None, *, title: Optional[str] = None) -> dict:
    """The value to pass to ``interrupt()``. ``interrupt()`` then returns
    ``{"decision", "approved", "input", "reason"}``: ``input`` is the
    reviewer's input for an edit and the original input otherwise."""
    value = {"type": INTERRUPT_TYPE, "tool": tool, "input": input}
    if title:
        value["title"] = title
    return value


def _interrupts(source: Any) -> list:
    if isinstance(source, dict):
        return list(source.get("__interrupt__") or [])
    if hasattr(source, "tasks") or hasattr(source, "interrupts"):  # StateSnapshot is a tuple too
        found = getattr(source, "interrupts", None)
        if found:
            return list(found)
        return [i for t in getattr(source, "tasks", None) or [] for i in (getattr(t, "interrupts", None) or [])]
    if isinstance(source, (list, tuple)):
        return list(source)
    return []


def approval_calls(source: Any) -> tuple[list[dict], Optional[str]]:
    """Approval calls among the interrupts of a paused run: the ``invoke()``
    result, ``graph.get_state(config)``, or a list of interrupts. Returns
    ``(calls, title)``; interrupts not made with ``approval()`` are skipped."""
    calls: list[dict] = []
    title = None
    for it in _interrupts(source):
        value = getattr(it, "value", None) if not isinstance(it, dict) else it.get("value")
        iid = getattr(it, "id", None) if not isinstance(it, dict) else it.get("id")
        if not isinstance(value, dict) or value.get("type") != INTERRUPT_TYPE or not iid:
            continue
        calls.append({"id": str(iid), "tool": value["tool"], "input": value.get("input")})
        title = title or value.get("title")
    return calls, title


def decision_for(call: dict) -> dict:
    """What ``interrupt()`` returns for one decided call."""
    return {
        "decision": call["decision"],
        "approved": call["decision"] != "reject",
        "input": call["edited_input"] if call["decision"] == "edit" else call["input"],
        "reason": call.get("reason"),
    }


def resume_value(request: dict) -> dict:
    """The ``resume`` map for ``Command(resume=...)``, keyed by interrupt id."""
    return {c["id"]: decision_for(c) for c in request["calls"]}
