import operator
from typing import Annotated, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from hibira_approvals import Approvals
from hibira_approvals.langgraph import approval, approval_calls, resume_value


class State(TypedDict):
    order: int
    log: Annotated[list, operator.add]


def refund(state: State):
    d = interrupt(approval("refund", {"order": state["order"]}, title="Refund and tell the customer"))
    return {"log": [f"refund {d['input']['order']}" if d["approved"] else f"no refund: {d['reason']}"]}


def email(state: State):
    d = interrupt(approval("send_email", {"to": "ann@example.com"}))
    return {"log": [f"email {d['input']['to']}" if d["approved"] else "no email"]}


def build():
    g = StateGraph(State)
    g.add_node("refund", refund)
    g.add_node("email", email)
    g.add_edge(START, "refund")
    g.add_edge(START, "email")
    g.add_edge("refund", END)
    g.add_edge("email", END)
    return g.compile(checkpointer=InMemorySaver())


async def test_parallel_interrupts_edit_and_reject():
    graph = build()
    config = {"configurable": {"thread_id": "t1"}}
    final = {}

    def resume(req):
        final.update(graph.invoke(Command(resume=resume_value(req)), req["metadata"]["config"]))

    approvals = Approvals(resume=resume)
    paused = graph.invoke({"order": 1042, "log": []}, config)
    calls, title = approval_calls(paused)
    assert title == "Refund and tell the customer"
    assert sorted(c["tool"] for c in calls) == ["refund", "send_email"]
    from_state, _ = approval_calls(graph.get_state(config))
    assert sorted(c["id"] for c in from_state) == sorted(c["id"] for c in calls)
    req = await approvals.request(calls, title=title, metadata={"config": config})
    ids = {c["tool"]: c["id"] for c in calls}
    done = await approvals.decide(
        req["id"],
        {ids["refund"]: {"decision": "edit", "input": {"order": 7}}, ids["send_email"]: {"decision": "reject", "reason": "later"}},
        send=True,
    )
    assert done["status"] == "resumed", done["error"]
    assert sorted(final["log"]) == ["no email", "refund 7"]
