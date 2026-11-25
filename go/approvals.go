// Package approvals asks a person for a decision from a Go server, job or
// agent with Hibira Approvals (https://hibira.io/approvals), and reads the
// answer.
//
// Requests are signed with the app's key and secret, like the rest of the
// Hibira HTTP API:
//
//	c := approvals.Client{AppID: os.Getenv("HIBIRA_APP_ID"), Key: os.Getenv("HIBIRA_APP_KEY"), Secret: os.Getenv("HIBIRA_APP_SECRET")}
//	a, err := c.Request(ctx, approvals.Request{Title: "Refund order #1042 for $89?", Options: []string{"Refund", "Decline"}})
//	// share a.URL with whoever decides, then
//	a, err = c.Wait(ctx, a.ID)
//	if err == nil && a.Approved() { refund() }
package approvals

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultHost serves the Hibira HTTP API.
const DefaultHost = "https://ws.hibira.io"

// MaxWait is the longest a single Get holds the request for an answer.
const MaxWait = 25 * time.Second

// Request asks for a decision. Only Title is required.
type Request struct {
	// Title is the question, at most 200 characters.
	Title string `json:"title"`
	// Details give more context, at most 4000 characters.
	Details string `json:"details,omitempty"`
	// Options are 2 to 4 choices; the first approves. Default Approve / Reject.
	Options []string `json:"options,omitempty"`
	// ExpiresInMinutes is 1 to 10080, default 60.
	ExpiresInMinutes int `json:"expires_in_minutes,omitempty"`
	// Channel receives an "approval" event on request and on decision.
	Channel string `json:"channel,omitempty"`
	// PushInterests or PushUsers (not both) get the link as a push notification.
	PushInterests []string `json:"push_interests,omitempty"`
	PushUsers     []string `json:"push_users,omitempty"`
	// Agent labels who asks, at most 60 characters.
	Agent string `json:"agent,omitempty"`
	// Approvers (Approvals workspaces) are members' emails or group slugs; only they may answer.
	Approvers []string `json:"approvers,omitempty"`
	// Quorum (Approvals workspaces, Business) is how many must approve.
	Quorum int `json:"quorum,omitempty"`
	// CallbackURL gets approval.decided or approval.expired for this request; see VerifyCallback.
	CallbackURL string `json:"callback_url,omitempty"`
}

// Person is who answered, on Approvals workspaces.
type Person struct {
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

// Message is a question from an approver or a reply from the requester.
type Message struct {
	ID      string    `json:"id"`
	From    string    `json:"from"` // "approver" or "requester"
	Name    string    `json:"name,omitempty"`
	Text    string    `json:"text"`
	Details string    `json:"details,omitempty"`
	At      time.Time `json:"at"`
}

// Approval is a request and its answer.
type Approval struct {
	ID      string   `json:"approval_id"`
	AppID   string   `json:"app_id,omitempty"`
	Title   string   `json:"title"`
	Options []string `json:"options"`
	// Status is pending, approved (the first option), rejected or expired.
	Status string `json:"status"`
	// URL is the answer page to share with whoever decides.
	URL        string     `json:"url"`
	Choice     string     `json:"choice,omitempty"`
	Comment    string     `json:"comment,omitempty"`
	AnsweredBy *Person    `json:"answered_by,omitempty"`
	CreatedAt  *time.Time `json:"created_at,omitempty"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	AnsweredAt *time.Time `json:"answered_at,omitempty"`
	PushError  string     `json:"push_error,omitempty"`
	// Discussion holds approvers' questions and the replies, oldest first.
	Discussion []Message `json:"discussion,omitempty"`
	// AwaitingReply is true while an approver's question waits for Reply.
	AwaitingReply bool `json:"awaiting_reply,omitempty"`
	// Raw is the whole JSON answer, for fields this struct does not name.
	Raw json.RawMessage `json:"-"`
}

// Pending reports whether nobody has answered and it has not expired.
func (a *Approval) Pending() bool { return a.Status == "pending" }

// Approved reports whether the first option was chosen.
func (a *Approval) Approved() bool { return a.Status == "approved" }

// Error is an answer from the API other than 2xx.
type Error struct {
	Status  int
	Message string
	Body    []byte
}

func (e *Error) Error() string { return fmt.Sprintf("approvals: %d %s", e.Status, e.Message) }

// Client calls the Approvals API of one Hibira app.
type Client struct {
	AppID  string
	Key    string
	Secret string
	// Host defaults to DefaultHost.
	Host string
	// HTTPClient defaults to a client without a timeout; each call has its own.
	HTTPClient *http.Client
	// Now defaults to time.Now.
	Now func() time.Time
}

// Request creates an approval request and returns it with its answer URL.
func (c *Client) Request(ctx context.Context, r Request) (*Approval, error) {
	if strings.TrimSpace(r.Title) == "" {
		return nil, errors.New("approvals: Title is required")
	}
	body, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	return c.call(ctx, http.MethodPost, "/approvals", nil, body, 15*time.Second)
}

// Get reads an approval. A wait above zero (up to MaxWait) holds the request
// until the person answers, an approver asks a question, or the time runs out.
func (c *Client) Get(ctx context.Context, id string, wait time.Duration) (*Approval, error) {
	if id == "" {
		return nil, errors.New("approvals: id is required")
	}
	if wait > MaxWait {
		wait = MaxWait
	}
	q := url.Values{}
	if secs := int(wait / time.Second); secs > 0 {
		q.Set("wait", strconv.Itoa(secs))
	}
	return c.call(ctx, http.MethodGet, "/approvals/"+url.PathEscape(id), q, nil, wait+15*time.Second)
}

// Wait polls until the approval is no longer pending or ctx is done, and
// returns it. Give ctx a deadline to stop waiting.
func (c *Client) Wait(ctx context.Context, id string) (*Approval, error) {
	for {
		wait := MaxWait
		if d, ok := ctx.Deadline(); ok {
			if left := time.Until(d); left < wait {
				wait = left
			}
		}
		a, err := c.Get(ctx, id, wait)
		if err != nil {
			return a, err
		}
		if !a.Pending() {
			return a, nil
		}
		if err := ctx.Err(); err != nil {
			return a, err
		}
		if wait < time.Second {
			select {
			case <-ctx.Done():
				return a, ctx.Err()
			case <-time.After(time.Second):
			}
		}
	}
}

// Reply answers an approver's question (Approval.AwaitingReply). details,
// when not empty, replaces the request's details for the approvers.
func (c *Client) Reply(ctx context.Context, id, message, details string) (*Approval, error) {
	if id == "" || strings.TrimSpace(message) == "" {
		return nil, errors.New("approvals: id and message are required")
	}
	body, _ := json.Marshal(struct {
		Message string `json:"message"`
		Details string `json:"details,omitempty"`
	}{message, details})
	return c.call(ctx, http.MethodPost, "/approvals/"+url.PathEscape(id)+"/replies", nil, body, 15*time.Second)
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// SignedQuery is the query string of a signed Hibira HTTP API request:
// auth_key, auth_timestamp, auth_version, body_md5 and auth_signature.
func SignedQuery(key, secret, method, path string, query url.Values, body []byte, now time.Time) string {
	params := map[string]string{}
	for k, v := range query {
		if len(v) > 0 {
			params[k] = v[0]
		}
	}
	params["auth_key"] = key
	params["auth_timestamp"] = strconv.FormatInt(now.Unix(), 10)
	params["auth_version"] = "1.0"
	if body != nil {
		sum := md5.Sum(body)
		params["body_md5"] = hex.EncodeToString(sum[:])
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, len(keys))
	for i, k := range keys {
		pairs[i] = k + "=" + params[k]
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(method + "\n" + path + "\n" + strings.Join(pairs, "&")))
	out := url.Values{}
	for k, v := range params {
		out.Set(k, v)
	}
	out.Set("auth_signature", hex.EncodeToString(m.Sum(nil)))
	return out.Encode()
}

func (c *Client) call(ctx context.Context, method, resource string, query url.Values, body []byte, timeout time.Duration) (*Approval, error) {
	if c.AppID == "" || c.Key == "" || c.Secret == "" {
		return nil, errors.New("approvals: AppID, Key and Secret are required")
	}
	host := strings.TrimRight(c.Host, "/")
	if host == "" {
		host = DefaultHost
	}
	path := "/apps/" + url.PathEscape(c.AppID) + resource
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, host+path+"?"+SignedQuery(c.Key, c.Secret, method, path, query, body, c.now()), rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "hibira-approvals-go")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTPClient
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		msg := strings.TrimSpace(string(raw))
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		return nil, &Error{Status: res.StatusCode, Message: msg, Body: raw}
	}
	var a Approval
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("approvals: bad answer: %w", err)
	}
	a.Raw = raw
	return &a, nil
}

// Event is a callback_url delivery: approval.decided or approval.expired.
type Event struct {
	ID          string    `json:"id"`
	Type        string    `json:"type"`
	CreatedAt   time.Time `json:"created_at"`
	WorkspaceID string    `json:"workspace_id,omitempty"`
	Data        struct {
		Approval Approval `json:"approval"`
	} `json:"data"`
}

// CallbackTolerance is how old a callback's timestamp may be.
const CallbackTolerance = 5 * time.Minute

// VerifyCallback checks a callback_url delivery (or a workspace webhook,
// with that endpoint's apwh_ secret) and returns its event. header is the
// Hibira-Signature header, "t=<unix>,v1=<hex>", where v1 is
// HMAC-SHA256(secret, "<t>.<body>"). It returns nil for a forged, malformed
// or stale delivery.
func VerifyCallback(secret, header string, body []byte, now time.Time) *Event {
	if secret == "" {
		return nil
	}
	var ts string
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch k {
		case "t":
			ts = v
		case "v1":
			sigs = append(sigs, v)
		}
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || len(sigs) == 0 {
		return nil
	}
	if now.IsZero() {
		now = time.Now()
	}
	if d := now.Sub(time.Unix(t, 0)); d > CallbackTolerance || d < -CallbackTolerance {
		return nil
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(ts + "." + string(body)))
	want := m.Sum(nil)
	ok := false
	for _, s := range sigs {
		if got, err := hex.DecodeString(s); err == nil && hmac.Equal(got, want) {
			ok = true
		}
	}
	if !ok {
		return nil
	}
	var e Event
	if json.Unmarshal(body, &e) != nil {
		return nil
	}
	return &e
}
