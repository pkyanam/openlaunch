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
