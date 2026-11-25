package approvals

import (
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const pendingJSON = `{"approval_id":"apr_1","app_id":"app_1","title":"Refund?","options":["Refund","Decline"],"status":"pending","url":"https://hibira.io/approve/apr_1/x","created_at":"2026-11-25T10:00:00Z","expires_at":"2026-11-25T11:00:00Z"}`

type seen struct {
	method, path string
	query        url.Values
	body         []byte
}

func server(t *testing.T, answers ...func(w http.ResponseWriter)) (*Client, *[]seen) {
	t.Helper()
	var mu sync.Mutex
	var got []seen
	i := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = append(got, seen{r.Method, r.URL.EscapedPath(), r.URL.Query(), b})
		a := answers[min(i, len(answers)-1)]
		i++
		mu.Unlock()
		checkSignature(t, r, b)
		a(w)
	}))
	t.Cleanup(srv.Close)
	return &Client{AppID: "1", Key: "app-key", Secret: "app-secret", Host: srv.URL + "/"}, &got
}

func checkSignature(t *testing.T, r *http.Request, body []byte) {
	t.Helper()
	q := r.URL.Query()
	sig := q.Get("auth_signature")
	q.Del("auth_signature")
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, len(keys))
	for i, k := range keys {
		pairs[i] = k + "=" + q.Get(k)
	}
	m := hmac.New(sha256.New, []byte("app-secret"))
	m.Write([]byte(r.Method + "\n" + r.URL.EscapedPath() + "\n" + strings.Join(pairs, "&")))
	if sig != hex.EncodeToString(m.Sum(nil)) {
		t.Errorf("bad signature for %s %s", r.Method, r.URL)
	}
	if q.Get("auth_key") != "app-key" || q.Get("auth_version") != "1.0" {
		t.Errorf("auth params missing: %v", q)
	}
	if len(body) > 0 {
		sum := md5.Sum(body)
		if q.Get("body_md5") != hex.EncodeToString(sum[:]) {
			t.Errorf("bad body_md5")
		}
	}
}

func answer(status int, body string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func TestRequest(t *testing.T) {
	c, got := server(t, answer(201, pendingJSON))
	a, err := c.Request(context.Background(), Request{Title: "Refund?", Options: []string{"Refund", "Decline"}, Channel: "private-ops", Approvers: []string{"finance"}})
	if err != nil {
		t.Fatal(err)
	}
	if a.ID != "apr_1" || !a.Pending() || a.Approved() || a.URL == "" || a.ExpiresAt == nil || len(a.Raw) == 0 {
		t.Fatalf("approval = %+v", a)
	}
	s := (*got)[0]
	if s.method != "POST" || s.path != "/apps/1/approvals" {
		t.Fatalf("request %s %s", s.method, s.path)
	}
	var body map[string]any
	_ = json.Unmarshal(s.body, &body)
	if len(body) != 4 || body["title"] != "Refund?" || body["channel"] != "private-ops" {
		t.Fatalf("body = %s", s.body)
	}
	if _, err := c.Request(context.Background(), Request{Title: " "}); err == nil {
		t.Fatal("empty title accepted")
	}
}

func TestGetCapsWaitAndEscapes(t *testing.T) {
	c, got := server(t, answer(200, strings.Replace(pendingJSON, `"pending"`, `"approved","choice":"Refund","answered_by":{"email":"a@example.com"}`, 1)))
	a, err := c.Get(context.Background(), "apr/1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !a.Approved() || a.Choice != "Refund" || a.AnsweredBy.Email != "a@example.com" {
		t.Fatalf("approval = %+v", a)
	}
	s := (*got)[0]
	if s.path != "/apps/1/approvals/apr%2F1" || s.query.Get("wait") != "25" {
		t.Fatalf("got %s ?%v", s.path, s.query)
	}
	c2, got2 := server(t, answer(200, pendingJSON))
	if _, err := c2.Get(context.Background(), "apr_1", 0); err != nil {
		t.Fatal(err)
	}
	if (*got2)[0].query.Has("wait") {
		t.Fatal("wait sent for 0")
	}
	if _, err := c.Get(context.Background(), "", 0); err == nil {
		t.Fatal("empty id accepted")
	}
}

func TestWaitPollsUntilAnswered(t *testing.T) {
	c, got := server(t, answer(200, pendingJSON), answer(200, strings.Replace(pendingJSON, `"pending"`, `"rejected"`, 1)))
	a, err := c.Wait(context.Background(), "apr_1")
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != "rejected" || len(*got) != 2 {
		t.Fatalf("status %s after %d calls", a.Status, len(*got))
	}
}

func TestWaitStopsAtDeadline(t *testing.T) {
	c, _ := server(t, answer(200, pendingJSON))
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	a, err := c.Wait(ctx, "apr_1")
	if !errors.Is(err, context.DeadlineExceeded) || a == nil || !a.Pending() {
		t.Fatalf("a=%v err=%v", a, err)
	}
}

func TestReply(t *testing.T) {
	c, got := server(t, answer(201, pendingJSON))
	if _, err := c.Reply(context.Background(), "apr_1", "Staging only", ""); err != nil {
		t.Fatal(err)
	}
	s := (*got)[0]
	if s.path != "/apps/1/approvals/apr_1/replies" || string(s.body) != `{"message":"Staging only"}` {
		t.Fatalf("got %s %s", s.path, s.body)
	}
	if _, err := c.Reply(context.Background(), "apr_1", "", ""); err == nil {
		t.Fatal("empty message accepted")
	}
}

func TestErrors(t *testing.T) {
	c, _ := server(t, answer(403, `{"error":"account suspended"}`))
	_, err := c.Request(context.Background(), Request{Title: "x"})
	var e *Error
	if !errors.As(err, &e) || e.Status != 403 || e.Message != "account suspended" {
		t.Fatalf("err = %v", err)
	}
	c, _ = server(t, answer(502, ``))
	if _, err := c.Get(context.Background(), "a", 0); !errors.As(err, &e) || e.Message != "Bad Gateway" {
		t.Fatalf("err = %v", err)
	}
	c, _ = server(t, answer(200, `not json`))
	if _, err := c.Get(context.Background(), "a", 0); err == nil {
		t.Fatal("bad JSON accepted")
	}
	if _, err := (&Client{}).Get(context.Background(), "a", 0); err == nil {
		t.Fatal("missing credentials accepted")
	}
}

func TestSignedQueryIsStable(t *testing.T) {
	now := time.Unix(1800000000, 0)
	q := SignedQuery("k", "s", "GET", "/apps/1/approvals/a", url.Values{"wait": {"5"}}, nil, now)
	v, _ := url.ParseQuery(q)
	if v.Get("auth_timestamp") != "1800000000" || v.Get("wait") != "5" || v.Has("body_md5") {
		t.Fatalf("query %s", q)
	}
	m := hmac.New(sha256.New, []byte("s"))
	m.Write([]byte("GET\n/apps/1/approvals/a\nauth_key=k&auth_timestamp=1800000000&auth_version=1.0&wait=5"))
	if v.Get("auth_signature") != hex.EncodeToString(m.Sum(nil)) {
		t.Fatal("signature mismatch")
	}
}

func sign(secret string, t int64, body string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(strconv.FormatInt(t, 10) + "." + body))
	return "t=" + strconv.FormatInt(t, 10) + ",v1=" + hex.EncodeToString(m.Sum(nil))
}

func TestVerifyCallback(t *testing.T) {
	now := time.Unix(1800000000, 0)
	body := `{"id":"evt_1","type":"approval.decided","created_at":"2026-11-25T10:00:00Z","data":{"approval":{"approval_id":"apr_1","status":"approved","choice":"Refund"}}}`
	e := VerifyCallback("app-secret", sign("app-secret", now.Unix(), body), []byte(body), now)
	if e == nil || e.Type != "approval.decided" || e.Data.Approval.ID != "apr_1" || !e.Data.Approval.Approved() {
		t.Fatalf("event = %+v", e)
	}
	for name, h := range map[string]string{
		"forged":    sign("other", now.Unix(), body),
		"stale":     sign("app-secret", now.Unix()-600, body),
		"future":    sign("app-secret", now.Unix()+600, body),
		"malformed": "v1=abc",
		"empty":     "",
	} {
		if VerifyCallback("app-secret", h, []byte(body), now) != nil {
			t.Errorf("%s callback accepted", name)
		}
	}
	if VerifyCallback("", sign("", now.Unix(), body), []byte(body), now) != nil {
		t.Error("empty secret accepted")
	}
	if VerifyCallback("app-secret", sign("app-secret", now.Unix(), "nope"), []byte("nope"), now) != nil {
		t.Error("bad JSON accepted")
	}
	two := "t=1800000000,v1=00," + strings.TrimPrefix(sign("app-secret", now.Unix(), body), "t=1800000000,")
	if VerifyCallback("app-secret", two, []byte(body), now) == nil {
		t.Error("second v1 signature not tried")
	}
}
