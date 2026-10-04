package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestURL(t *testing.T) {
	for _, s := range []string{"https:", "https:///", "http://example.com", "https://u:p@example.com", "https://example.com?token=x"} {
		if validateURL(s) == nil {
			t.Fatal("accepted", s)
		}
	}
	for _, s := range []string{"https://openlaunch.dev", "http://127.0.0.1:8788"} {
		if validateURL(s) != nil {
			t.Fatal("rejected", s)
		}
	}
}
func TestNoUnregisteredHardwareAction(t *testing.T) {
	r := execute(Config{}, Command{Capability: "led.set", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, time.Now())
	if r.Status != "failed" {
		t.Fatal("unimplemented hardware action succeeded")
	}
}
func TestExpired(t *testing.T) {
	r := execute(Config{Simulate: true}, Command{Capability: "led.set", ExpiresAt: 1}, time.Now())
	if r.Status != "failed" {
		t.Fatal("expired action executed")
	}
}

func sdkToken() string {
	return "ol_sdk_" + strings.Repeat("a", 64) + "_" + strings.Repeat("b", 64)
}

func TestSDKAttachPersistsRetryAndNeverStoresMasterToken(t *testing.T) {
	var mu sync.Mutex
	var requests []map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sdk/devices" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+sdkToken() {
			t.Errorf("SDK token was not sent as bearer authorization")
		}
		if got := r.Header.Get("x-openlaunch-workspace"); got != strings.Repeat("a", 64) {
			t.Errorf("workspace was not derived from token")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		var request map[string]any
		if err := json.Unmarshal(body, &request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		mu.Lock()
		requests = append(requests, request)
		count := len(requests)
		mu.Unlock()
		if count == 1 {
			// Model the cloud committing the attach and the response disappearing.
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("TLS test response does not support hijacking")
				return
			}
			conn, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack response: %v", err)
				return
			}
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"data":{"deviceId":"device-123","token":"child-credential-only"}}`)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	configPath := filepath.Join(t.TempDir(), "device.json")
	if err := attachDevice(server.URL, configPath, sdkToken(), false); err == nil {
		t.Fatal("first attach should observe the dropped response")
	}
	pendingPath := configPath + ".attach-pending"
	pendingBytes, err := os.ReadFile(pendingPath)
	if err != nil {
		t.Fatalf("retry metadata was not persisted: %v", err)
	}
	if strings.Contains(string(pendingBytes), sdkToken()) {
		t.Fatal("pending metadata contains the owner SDK token")
	}
	var pending AttachPending
	if err := json.Unmarshal(pendingBytes, &pending); err != nil {
		t.Fatal(err)
	}
	if pending.Workspace != strings.Repeat("a", 64) || !isUUID(pending.RequestID) {
		t.Fatalf("unexpected pending identity: %+v", pending)
	}
	if err := attachDevice(server.URL, configPath, sdkToken(), false); err != nil {
		t.Fatalf("retry after process restart: %v", err)
	}
	if len(requests) != 2 {
		t.Fatalf("expected 2 requests, got %d", len(requests))
	}
	if requests[0]["requestId"] != requests[1]["requestId"] {
		t.Fatalf("retry changed request ID: %v vs %v", requests[0]["requestId"], requests[1]["requestId"])
	}
	firstManifest, _ := json.Marshal(requests[0]["manifest"])
	secondManifest, _ := json.Marshal(requests[1]["manifest"])
	if string(firstManifest) != string(secondManifest) {
		t.Fatal("retry changed manifest")
	}
	configBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(configBytes), sdkToken()) || strings.Contains(string(configBytes), "secret") {
		t.Fatal("device config contains owner SDK token material")
	}
	var config Config
	if err := json.Unmarshal(configBytes, &config); err != nil {
		t.Fatal(err)
	}
	if config.Token != "child-credential-only" || config.Workspace != strings.Repeat("a", 64) {
		t.Fatalf("unexpected saved device identity: %+v", config)
	}
	if _, err := os.Lstat(pendingPath); !os.IsNotExist(err) {
		t.Fatalf("pending metadata should be removed after saving the child credential, err=%v", err)
	}
}

func TestSDKAttachQuotaErrorKeepsPendingRequest(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = fmt.Fprint(w, `{"error":{"message":"SDK token device limit reached"}}`)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	configPath := filepath.Join(t.TempDir(), "device.json")
	err := attachDevice(server.URL, configPath, sdkToken(), false)
	if err == nil || !strings.Contains(err.Error(), "HTTP 429") {
		t.Fatalf("expected quota HTTP status, got %v", err)
	}
	if _, err := os.Stat(configPath + ".attach-pending"); err != nil {
		t.Fatalf("quota error should retain retry metadata for safe inspection: %v", err)
	}
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Fatalf("quota error created a device config: %v", err)
	}
}

func TestSDKAttachExpiredRetryStopsAndMarksPending(t *testing.T) {
	requests := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusConflict)
		_, _ = fmt.Fprint(w, `{"error":{"code":"attachment_expired","message":"expired"}}`)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	configPath := filepath.Join(t.TempDir(), "device.json")
	err := attachDevice(server.URL, configPath, sdkToken(), false)
	if !errors.Is(err, errAttachmentExpired) {
		t.Fatalf("expected explicit expired-retry error, got %v", err)
	}
	if _, err := os.Stat(configPath + ".attach-pending.expired"); err != nil {
		t.Fatalf("expired request was not marked: %v", err)
	}
	if _, err := os.Stat(configPath + ".attach-pending"); !os.IsNotExist(err) {
		t.Fatalf("expired pending request should not be retried, err=%v", err)
	}
	if err := attachDevice(server.URL, configPath, sdkToken(), false); !errors.Is(err, errAttachmentExpired) {
		t.Fatalf("second attempt should require inventory check, got %v", err)
	}
	if requests != 1 {
		t.Fatalf("expired request was automatically retried %d times", requests)
	}
}

func TestSDKTokenValidationAndLegacyAgentToken(t *testing.T) {
	workspace := strings.Repeat("c", 64)
	secret := strings.Repeat("d", 64)
	for _, token := range []string{"ol_sdk_" + workspace + "_" + secret, "ol_agent_" + workspace + "_" + secret} {
		got, err := sdkTokenWorkspace(token)
		if err != nil || got != workspace {
			t.Fatalf("valid SDK token rejected: workspace=%q err=%v", got, err)
		}
	}
	for _, token := range []string{"", "ol_sdk_short_" + secret, "ol_sdk_" + workspace + "_" + strings.Repeat("G", 64)} {
		if _, err := sdkTokenWorkspace(token); err == nil {
			t.Fatalf("invalid token accepted: %q", token)
		}
	}
}

const testActionID = "123e4567-e89b-42d3-a456-426614174000"

func TestResultRecoveryAfterLostResponseDoesNotReplayAction(t *testing.T) {
	var resultCalls, pollCalls, commits, effects int
	var accepted map[string]any
	var requests []map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/device/device-123/next" {
			pollCalls++
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"data":null}`)
			return
		}
		if r.URL.Path != "/v1/device/device-123/result" {
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode result request: %v", err)
			return
		}
		requests = append(requests, request)
		resultCalls++
		if accepted == nil {
			// Simulate the server committing the result, then losing its response.
			accepted = request
			commits++
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("TLS test response does not support hijacking")
				return
			}
			conn, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack result response: %v", err)
				return
			}
			_ = conn.Close()
			return
		}
		if !reflect.DeepEqual(accepted, request) {
			t.Errorf("retry changed result payload: first=%v retry=%v", accepted, request)
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"id": request["actionId"], "status": request["status"], "result": request["result"],
		}})
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	config := Config{URL: server.URL, Workspace: strings.Repeat("a", 64), DeviceID: "device-123", Token: "child-token"}
	journalPath := filepath.Join(t.TempDir(), "device.json.journal")
	journal := map[string]JournalEntry{}
	command := Command{ID: testActionID, Capability: "device.health", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	started := time.Now()
	spy := func(c Config, cmd Command, at time.Time) Outcome {
		effects++
		before, migrated, err := loadJournal(journalPath)
		if err != nil || migrated || before[cmd.ID].State != journalUnknown || before[cmd.ID].ExpiresAt != cmd.ExpiresAt {
			t.Errorf("execution did not start after durable unknown marker: migrated=%v entry=%+v err=%v", migrated, before[cmd.ID], err)
		}
		return Outcome{Status: "succeeded", Result: map[string]any{"simulated": false, "count": effects}}
	}
	if err := processCommand(config, command, started, journal, journalPath, spy); err != nil {
		t.Fatal(err)
	}
	if effects != 1 || journal[testActionID].State != journalPending {
		t.Fatalf("execution was not durably recorded: effects=%d entry=%+v", effects, journal[testActionID])
	}
	if err := reconcileResults(config, journal, journalPath, time.Now().UnixMilli()); err == nil {
		t.Fatal("first upload should observe its response being lost")
	}
	loaded, migrated, err := loadJournal(journalPath)
	if err != nil || migrated {
		t.Fatalf("could not reload durable journal: migrated=%v err=%v", migrated, err)
	}
	if loaded[testActionID].State != journalPending {
		t.Fatalf("lost response was incorrectly marked acknowledged: %+v", loaded[testActionID])
	}
	// Re-entering command handling for the same ID cannot invoke the handler.
	if err := processCommand(config, command, started, loaded, journalPath, spy); err != nil {
		t.Fatal(err)
	}
	if effects != 1 {
		t.Fatalf("duplicate delivery replayed the action %d times", effects)
	}
	// Reconciliation is independent of /next and safely repeats the exact receipt.
	if err := reconcileResults(config, loaded, journalPath, time.Now().UnixMilli()); err != nil {
		t.Fatalf("result recovery after restart: %v", err)
	}
	if resultCalls != 2 || commits != 1 || pollCalls != 0 {
		t.Fatalf("unexpected recovery counts: result requests=%d server commits=%d polls=%d", resultCalls, commits, pollCalls)
	}
	if !reflect.DeepEqual(requests[0], requests[1]) {
		t.Fatalf("result retry payload changed: %v != %v", requests[0], requests[1])
	}
	if loaded[testActionID].State != journalAcked {
		t.Fatalf("matching receipt did not mark journal acknowledged: %+v", loaded[testActionID])
	}
	if err := reconcileResults(config, loaded, journalPath, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if resultCalls != 2 {
		t.Fatalf("acknowledged result was uploaded again: calls=%d", resultCalls)
	}
}

func TestResultReceiptMustMatchActionAndStatus(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"data":{"id":"other-action","status":"failed"}}`)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	config := Config{URL: server.URL, Workspace: strings.Repeat("a", 64), DeviceID: "device-123", Token: "child-token"}
	journalPath := filepath.Join(t.TempDir(), "journal.json")
	journal := map[string]JournalEntry{
		testActionID: {State: journalPending, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Outcome: Outcome{Status: "succeeded", Result: map[string]any{"ok": true}}},
	}
	if err := saveJournal(journalPath, journal); err != nil {
		t.Fatal(err)
	}
	err := reconcileResults(config, journal, journalPath, time.Now().UnixMilli())
	var delivery resultDeliveryError
	if !errors.As(err, &delivery) || !delivery.Terminal || !errors.Is(err, errReceiptMismatch) {
		t.Fatalf("mismatched receipt should halt while retaining state, got %v", err)
	}
	loaded, _, err := loadJournal(journalPath)
	if err != nil || loaded[testActionID].State != journalPending {
		t.Fatalf("mismatch lost pending result: state=%+v err=%v", loaded[testActionID], err)
	}
}

func TestResultReceiptMustMatchResultValue(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"data":{"id":%q,"status":"succeeded","result":{"ok":false}}}`, testActionID)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	config := Config{URL: server.URL, Workspace: strings.Repeat("a", 64), DeviceID: "device-123", Token: "child-token"}
	journalPath := filepath.Join(t.TempDir(), "journal.json")
	journal := map[string]JournalEntry{
		testActionID: {State: journalPending, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Outcome: Outcome{Status: "succeeded", Result: map[string]any{"ok": true}}},
	}
	if err := saveJournal(journalPath, journal); err != nil {
		t.Fatal(err)
	}
	err := reconcileResults(config, journal, journalPath, time.Now().UnixMilli())
	var delivery resultDeliveryError
	if !errors.As(err, &delivery) || !delivery.Terminal || !errors.Is(err, errReceiptMismatch) {
		t.Fatalf("mismatched result should halt while retaining state, got %v", err)
	}
	loaded, _, err := loadJournal(journalPath)
	if err != nil || loaded[testActionID].State != journalPending {
		t.Fatalf("mismatched result lost pending outcome: entry=%+v err=%v", loaded[testActionID], err)
	}
}

func TestAmbiguousInterruptionHaltsBeforeExpiryWithoutReplayingOrPolling(t *testing.T) {
	var requests int
	var polls int
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/next") {
			polls++
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"data":{"id":"next-action"}}`)
			return
		}
		requests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"data":{"id":"other-action","status":"succeeded"}}`)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	config := Config{URL: server.URL, Workspace: strings.Repeat("a", 64), DeviceID: "device-123", Token: "child-token"}
	journalPath := filepath.Join(t.TempDir(), "journal.json")
	journal := map[string]JournalEntry{
		testActionID: {State: journalUnknown, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Outcome: Outcome{Status: "unknown", Result: map[string]any{"error": "interrupted_execution"}}},
	}
	if err := saveJournal(journalPath, journal); err != nil {
		t.Fatal(err)
	}
	effects := 0
	if err := processCommand(config, Command{ID: testActionID, Capability: "device.health", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, time.Now(), journal, journalPath, func(Config, Command, time.Time) Outcome {
		effects++
		return Outcome{Status: "succeeded"}
	}); err != nil {
		t.Fatal(err)
	}
	if effects != 0 {
		t.Fatal("interrupted action handler was replayed")
	}
	err := reconcileResults(config, journal, journalPath, time.Now().UnixMilli())
	if !errors.Is(err, errInterruptedUnknown) || !haltOnResultError(err) {
		t.Fatalf("unexpired ambiguous outcome did not halt before polling: %v", err)
	}
	if err := reconcileResults(config, journal, journalPath, journal[testActionID].ExpiresAt+1); !errors.Is(err, errInterruptedUnknown) {
		t.Fatalf("expired ambiguous outcome did not remain halted: %v", err)
	}
	if requests != 0 || polls != 0 || journal[testActionID].State != journalUnknown {
		t.Fatalf("ambiguous outcome was uploaded, polled, or discarded: results=%d polls=%d entry=%+v", requests, polls, journal[testActionID])
	}
}

func TestRevokedOrMissingResultEndpointHaltsAndRetainsPending(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict, http.StatusUnprocessableEntity} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(status)
			}))
			defer server.Close()
			previousClient := httpClient
			httpClient = server.Client()
			defer func() { httpClient = previousClient }()

			config := Config{URL: server.URL, Workspace: strings.Repeat("a", 64), DeviceID: "device-123", Token: "child-token"}
			journalPath := filepath.Join(t.TempDir(), "journal.json")
			journal := map[string]JournalEntry{
				testActionID: {State: journalPending, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Outcome: Outcome{Status: "failed", Result: map[string]any{"error": "unsupported_capability"}}},
			}
			if err := saveJournal(journalPath, journal); err != nil {
				t.Fatal(err)
			}
			err := reconcileResults(config, journal, journalPath, time.Now().UnixMilli())
			var delivery resultDeliveryError
			if !errors.As(err, &delivery) || !delivery.Terminal || calls != 1 {
				t.Fatalf("HTTP %d should be terminal after one upload, calls=%d err=%v", status, calls, err)
			}
			loaded, _, err := loadJournal(journalPath)
			if err != nil || loaded[testActionID].State != journalPending {
				t.Fatalf("terminal response discarded unacknowledged result: entry=%+v err=%v", loaded[testActionID], err)
			}
		})
	}
}

func TestRateLimitedResultRetriesAfterRetryAfterWithoutReplayingAction(t *testing.T) {
	var resultCalls, commits, effects int
	var requests []map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode result request: %v", err)
			return
		}
		requests = append(requests, request)
		resultCalls++
		if resultCalls == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		commits++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"id": request["actionId"], "status": request["status"], "result": request["result"],
		}})
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()

	config := Config{URL: server.URL, Workspace: strings.Repeat("a", 64), DeviceID: "device-123", Token: "child-token"}
	journalPath := filepath.Join(t.TempDir(), "device.json.journal")
	journal := map[string]JournalEntry{}
	command := Command{ID: testActionID, Capability: "device.health", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	started := time.Now()
	spy := func(Config, Command, time.Time) Outcome {
		effects++
		return Outcome{Status: "succeeded", Result: map[string]any{"healthy": true}}
	}
	if err := processCommand(config, command, started, journal, journalPath, spy); err != nil {
		t.Fatal(err)
	}
	firstErr := reconcileResults(config, journal, journalPath, time.Now().UnixMilli())
	var firstDelivery resultDeliveryError
	if !errors.As(firstErr, &firstDelivery) || firstDelivery.Terminal || firstDelivery.RetryAfter < 1900*time.Millisecond || firstDelivery.RetryAfter > 2*time.Second {
		t.Fatalf("429 Retry-After was not scheduled safely: %+v err=%v", firstDelivery, firstErr)
	}
	if effects != 1 || journal[testActionID].RetryCount != 1 || journal[testActionID].State != journalPending {
		t.Fatalf("rate limited result was not retained without re-execution: effects=%d entry=%+v", effects, journal[testActionID])
	}
	loaded, migrated, err := loadJournal(journalPath)
	if err != nil || migrated {
		t.Fatalf("failed to reload saved retry schedule: migrated=%v err=%v", migrated, err)
	}
	entry := loaded[testActionID]
	if entry.NextAttemptAt <= 0 || entry.RetryCount != 1 {
		t.Fatalf("retry schedule was not durable: %+v", entry)
	}
	if err := reconcileResults(config, loaded, journalPath, entry.NextAttemptAt-1); err == nil {
		t.Fatal("retry should remain deferred until the saved Retry-After time")
	}
	if resultCalls != 1 {
		t.Fatalf("result retried before Retry-After elapsed: %d calls", resultCalls)
	}
	if err := reconcileResults(config, loaded, journalPath, entry.NextAttemptAt); err != nil {
		t.Fatalf("rate-limited result did not recover: %v", err)
	}
	if effects != 1 || resultCalls != 2 || commits != 1 || loaded[testActionID].State != journalAcked {
		t.Fatalf("unexpected post-retry effects: handler=%d requests=%d commits=%d entry=%+v", effects, resultCalls, commits, loaded[testActionID])
	}
	if !reflect.DeepEqual(requests[0], requests[1]) {
		t.Fatalf("result request changed across 429 retry: %v != %v", requests[0], requests[1])
	}
}

func Test408UsesBoundedBackoffAndTransientDelayNeverExceedsActionTTL(t *testing.T) {
	now := time.Now()
	if got := parseRetryAfter("5", now); got != 5*time.Second {
		t.Fatalf("parsed numeric Retry-After incorrectly: %s", got)
	}
	if got := parseRetryAfter(now.Add(3*time.Second).UTC().Format(http.TimeFormat), now); got < 2*time.Second || got > 3*time.Second {
		t.Fatalf("parsed HTTP-date Retry-After incorrectly: %s", got)
	}
	delay, next, ok := resultRetryDelay(1000, 5*time.Minute, now.UnixMilli()+2000, now.UnixMilli())
	if !ok || delay > 2*time.Second || next > now.UnixMilli()+2000 {
		t.Fatalf("retry delay exceeded action TTL: delay=%s next=%d ok=%v", delay, next, ok)
	}

	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusRequestTimeout)
	}))
	defer server.Close()
	previousClient := httpClient
	httpClient = server.Client()
	defer func() { httpClient = previousClient }()
	config := Config{URL: server.URL, Workspace: strings.Repeat("a", 64), DeviceID: "device-123", Token: "child-token"}
	journalPath := filepath.Join(t.TempDir(), "journal.json")
	journal := map[string]JournalEntry{testActionID: {
		State: journalPending, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(),
		Outcome: Outcome{Status: "failed", Result: map[string]any{"error": "unsupported_capability"}},
	}}
	if err := saveJournal(journalPath, journal); err != nil {
		t.Fatal(err)
	}
	err := reconcileResults(config, journal, journalPath, time.Now().UnixMilli())
	var delivery resultDeliveryError
	if !errors.As(err, &delivery) || delivery.Terminal || delivery.RetryAfter < time.Second || calls != 1 {
		t.Fatalf("408 did not receive bounded transient backoff: calls=%d delivery=%+v err=%v", calls, delivery, err)
	}
}

func TestLegacyJournalMigrationPreservesOutcomesSafely(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.json")
	legacy := map[string]Outcome{
		testActionID:                           {Status: "failed", Result: map[string]any{"error": "unsupported_capability"}},
		"123e4567-e89b-42d3-a456-426614174001": {Status: "unknown", Result: map[string]any{"error": "interrupted_execution"}},
	}
	if err := atomic(path, legacy); err != nil {
		t.Fatal(err)
	}
	entries, migrated, err := loadJournal(path)
	if err != nil || !migrated {
		t.Fatalf("legacy journal was not recognized: migrated=%v err=%v", migrated, err)
	}
	if entries[testActionID].State != journalPending || entries[testActionID].Outcome.Status != "failed" ||
		entries["123e4567-e89b-42d3-a456-426614174001"].State != journalUnknown {
		t.Fatalf("legacy outcomes were not safely preserved: %+v", entries)
	}
	if err := saveJournal(path, entries); err != nil {
		t.Fatal(err)
	}
	reloaded, migrated, err := loadJournal(path)
	if err != nil || migrated || reloaded[testActionID].Outcome.Result.(map[string]any)["error"] != "unsupported_capability" {
		t.Fatalf("migrated outcome changed: migrated=%v entry=%+v err=%v", migrated, reloaded[testActionID], err)
	}
}
