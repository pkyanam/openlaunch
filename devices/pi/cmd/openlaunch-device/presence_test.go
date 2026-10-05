package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	syncatomic "sync/atomic"
	"testing"
	"time"
)

func TestBusyPresenceWithoutSocketDoesNotFetchOrReplayCommands(t *testing.T) {
	var beats, operations syncatomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/device/"+uploadID+"/heartbeat" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer private-device-credential" || r.Header.Get("X-Openlaunch-Workspace") != strings.Repeat("a", 64) {
			t.Error("presence used wrong route or identity")
		}
		b, _ := io.ReadAll(r.Body)
		if string(b) != "{}" {
			t.Error("presence carries command data")
		}
		if beats.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"lastSeen": time.Now().UnixMilli()}})
	}))
	defer server.Close()
	c := eventFixtureConfig(server.URL)
	err := withDevicePresence(context.Background(), c, 10*time.Millisecond, func() error {
		operations.Add(1)
		deadline := time.Now().Add(2 * time.Second)
		for beats.Load() < 3 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if beats.Load() < 3 {
			t.Fatal("presence did not recover from an HTTP outage")
		}
		return nil
	})
	if err != nil || operations.Load() != 1 {
		t.Fatal("presence changed command outcome", err)
	}
	after := beats.Load()
	time.Sleep(30 * time.Millisecond)
	if beats.Load() != after {
		t.Fatal("presence continued after execution")
	}
	withDevicePresence(context.Background(), c, time.Second, func() error { return nil })
	if beats.Load() != after {
		t.Fatal("short commands add presence traffic")
	}
}

func TestBusyPresenceCancellationStopsInflightRequest(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	}))
	defer func() { server.CloseClientConnections(); server.Close() }()
	done := make(chan error, 1)
	go func() {
		done <- withDevicePresence(context.Background(), eventFixtureConfig(server.URL), time.Millisecond, func() error { <-started; return nil })
	}()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("presence cancellation blocked result delivery")
	}
}
