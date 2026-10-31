import asyncio
from datetime import timedelta

import pytest

from hibira_approvals import ApprovalError, Approvals, inbox_channel, request_channel


class FakePusher:
    def __init__(self):
        self.events = []

    def trigger(self, channel, event, data):
        self.events.append((channel, event, data))

    def authenticate(self, channel, socket_id, custom_data=None):
        out = {"auth": f"key:{socket_id}:{channel}"}
        if custom_data:
            out["channel_data"] = custom_data
        return out


CALLS = [
    {"id": "a", "tool": "refund_order", "input": {"order": 1042}},
    {"id": "b", "tool": "send_email", "input": {"to": "ann@example.com"}},
]


async def test_request_decide_send():
    pusher = FakePusher()
    resumed = []

    async def resume(r):
        resumed.append(r)

    approvals = Approvals(pusher, scope="support", resume=resume)
    r = await approvals.request(CALLS, agent="Support agent", title="Refund #1042")
    channel, event, data = pusher.events[0]
    assert channel == inbox_channel("support") and event == "approval"
    assert data["tools"] == ["refund_order", "send_email"] and data["v"] == 1 and "calls" not in data
    await approvals.decide(r["id"], {"a": {"decision": "approve"}}, by="Ann")
    with pytest.raises(ApprovalError) as e:
        await approvals.send(r["id"])
    assert e.value.code == "undecided"
    done = await approvals.decide(r["id"], {"b": {"decision": "reject", "reason": "No"}}, by="Bo", send=True)
    assert done["status"] == "resumed"
    assert resumed[0]["calls"][1]["reason"] == "No"
    assert [d["reason"] for _, _, d in pusher.events] == ["requested", "decided", "decided", "resuming", "resumed"]


async def test_concurrent_send_runs_once():
    n = []
    approvals = Approvals(resume=lambda r: n.append(1))
    r = await approvals.request(CALLS[:1])
    await approvals.decide(r["id"], {"a": {"decision": "approve"}})
    results = await asyncio.gather(*(approvals.send(r["id"]) for _ in range(3)), return_exceptions=True)
    assert sum(1 for x in results if not isinstance(x, Exception)) == 1
    assert n == [1]


async def test_failed_then_retry_and_validation():
    state = {"fail": True}

    def resume(r):
        if state["fail"]:
            raise RuntimeError("model down")

    approvals = Approvals(resume=resume, on_error=lambda e: None)
    r = await approvals.request(CALLS)
    with pytest.raises(ApprovalError):
        await approvals.decide(r["id"], {"a": {"decision": "edit"}})
    with pytest.raises(ApprovalError):
        await approvals.decide(r["id"], {"zz": {"decision": "approve"}})
    failed = await approvals.decide(
        r["id"], {"a": {"decision": "edit", "input": {"order": 7}}, "b": {"decision": "approve"}}, send=True
    )
    assert failed["status"] == "failed" and failed["error"] == "model down"
    state["fail"] = False
    assert (await approvals.retry(r["id"]))["status"] == "resumed"


async def test_expire_resolve_list_scope_wait():
    approvals = Approvals()
    other = Approvals(store=approvals.store, scope="other")
    old = await approvals.request(CALLS, expires_in=timedelta(milliseconds=1))
    live = await approvals.request(CALLS)
    answered = await approvals.request(CALLS)
    await asyncio.sleep(0.01)
    assert (await approvals.get(old["id"]))["status"] == "expired"
    await approvals.resolve(answered["id"])
    assert [r["id"] for r in await approvals.list()] == [live["id"]]
    assert [r["id"] for r in await approvals.list("done")] == [answered["id"], old["id"]]
    with pytest.raises(ApprovalError) as e:
        await other.get(live["id"])
    assert e.value.status == 404

    async def later():
        await asyncio.sleep(0.02)
        await approvals.decide(live["id"], {"a": {"decision": "approve"}, "b": {"decision": "approve"}}, send=True)

    asyncio.create_task(later())
    assert (await approvals.wait(live["id"], interval=0.005, timeout=2))["status"] == "resumed"


def test_authorize():
    approvals = Approvals(FakePusher(), scope="ops")
    me = {"id": 7, "name": "Ann"}
    assert approvals.authorize("1.2", inbox_channel("ops"), me)["auth"]
    p = approvals.authorize("1.2", request_channel("ops", "apr_x"), me)
    assert p["channel_data"] == {"user_id": "7", "user_info": {"name": "Ann"}}
    assert approvals.authorize("1.2", inbox_channel("sales"), me) is None
    with pytest.raises(ValueError):
        Approvals(scope="a.b")
