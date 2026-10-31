from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from hibira_approvals import Approvals
from hibira_approvals.fastapi import approvals_router

from .test_core import CALLS, FakePusher


def make():
    approvals = Approvals(FakePusher())

    def user(request: Request):
        uid = request.headers.get("x-user")
        return {"id": uid, "name": f"User {uid}"} if uid else None

    app = FastAPI()
    app.include_router(approvals_router(approvals, get_user=user, can_review=lambda u, r: u["id"] != "guest"), prefix="/api/approvals")
    return approvals, TestClient(app)


async def test_routes():
    approvals, http = make()
    r = await approvals.request(CALLS)
    h = {"x-user": "1"}
    assert http.get("/api/approvals").status_code == 401
    assert http.get("/api/approvals", headers={"x-user": "guest"}).status_code == 403
    assert [x["id"] for x in http.get("/api/approvals?status=pending", headers=h).json()["data"]] == [r["id"]]
    assert http.get(f"/api/approvals/{r['id']}", headers=h).json()["calls"][0]["input"] == {"order": 1042}
    assert http.get("/api/approvals/apr_nope", headers=h).status_code == 404
    res = http.post(f"/api/approvals/{r['id']}/decisions", json={"decisions": {"a": {"decision": "approve"}}}, headers=h).json()
    assert res["calls"][0]["decided_by"] == "User 1"
    assert http.post(f"/api/approvals/{r['id']}/send", headers=h).json()["error"] == "undecided"
    assert http.delete(f"/api/approvals/{r['id']}/decisions/a", headers=h).json()["calls"][0]["decision"] is None
    done = http.post(
        f"/api/approvals/{r['id']}/decisions",
        json={"decisions": {"a": {"decision": "approve"}, "b": {"decision": "approve"}}, "send": True},
        headers=h,
    ).json()
    assert done["status"] == "resumed"
    auth = http.post(
        "/api/approvals/auth",
        data={"socket_id": "1.2", "channel_name": "presence-hibira-approvals.default.reviewers"},
        headers=h,
    )
    assert auth.json()["channel_data"]["user_id"] == "1"
    assert http.post("/api/approvals/auth", data={"socket_id": "1.2", "channel_name": "private-x"}, headers=h).status_code == 403
