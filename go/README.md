# Hibira Approvals for Go

Ask a person for a decision from a Go server, job or agent with
[Hibira Approvals](https://hibira.io/approvals), and act on the answer. It is
the hosted approvals API (`/apps/APP_ID/approvals`), signed with your Hibira
app's key and secret: Hibira hosts the answer page, so there is no inbox to
run.

```sh
go get github.com/hibira-io/approvals/go
```

```go
import approvals "github.com/hibira-io/approvals/go"

c := approvals.Client{
	AppID:  os.Getenv("HIBIRA_APP_ID"),
	Key:    os.Getenv("HIBIRA_APP_KEY"),
	Secret: os.Getenv("HIBIRA_APP_SECRET"),
}

a, err := c.Request(ctx, approvals.Request{
	Title:            "Refund order #1042 for $89?",
	Details:          "Customer says the parcel arrived damaged.",
	Options:          []string{"Refund", "Decline"}, // the first option approves
	Channel:          "private-ops",                  // optional: an "approval" event on request and decision
	ExpiresInMinutes: 120,
})
// share a.URL with whoever decides, then wait (give ctx a deadline):
ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
defer cancel()
a, err = c.Wait(ctx, a.ID)
if err == nil && a.Approved() {
	refund(order)
}
```

- `c.Get(ctx, id, 25*time.Second)` reads one status, holding the request up
  to 25 seconds until it is answered.
- When an approver asks a question instead of deciding (`a.AwaitingReply`),
  answer with `c.Reply(ctx, id, "Staging only; 12 rows.", "")`.
- `Approvers`, `Quorum` and `CallbackURL` work on Approvals workspaces' apps.
- API errors are `*approvals.Error` with `Status` and the API's `Message`.

## Callbacks instead of polling

With `CallbackURL` set, Hibira POSTs `approval.decided` or `approval.expired`
to it, signed with the app's secret. Check it before trusting it:

```go
http.HandleFunc("/hooks/approvals", func(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	e := approvals.VerifyCallback(os.Getenv("HIBIRA_APP_SECRET"), r.Header.Get("Hibira-Signature"), body, time.Now())
	if e == nil {
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	// e.Type, e.Data.Approval.Status, e.Data.Approval.Choice
	w.WriteHeader(http.StatusNoContent)
})
```

Workspace webhooks use the same check with that endpoint's `apwh_` secret.
Deliveries can repeat: `e.ID` stays the same on every retry.

Go 1.21 or later, no dependencies.

## 中文摘要

`github.com/hibira-io/approvals/go` 讓 Go 程式用 Hibira app 的 key 與 secret
發出需要人決定的請求（`c.Request`），把回傳的 `URL` 分享給決策者，再用
`c.Wait` 等待結果（approved、rejected 或 expired）。決策者先提問時用
`c.Reply` 回答。設定 `CallbackURL` 後，Hibira 會在決定或過期時送出簽名的
callback，用 `approvals.VerifyCallback` 驗證。沒有任何外部相依套件。
