package main

import (
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	syncatomic "sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func eventFixtureConfig(origin string) Config {
	return Config{URL: origin, Workspace: strings.Repeat("a", 64), DeviceID: uploadID, Token: "private-device-credential", Profile: "linux"}
}

func awaitEvent(t *testing.T, wake <-chan struct{}) {
	t.Helper()
	select {
	case <-wake:
	case <-time.After(3 * time.Second):
		t.Fatal("event wake timed out")
	}
}

func TestDeviceEventsAuthenticateWakeAndHeartbeat(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var pings syncatomic.Int32
	work := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "events-ticket") {
			if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer private-device-credential" || r.Header.Get("X-Openlaunch-Workspace") != strings.Repeat("a", 64) {
				t.Error("ticket did not use the separate device credential")
			}
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"ticket": strings.Repeat("b", 64), "expiresAt": time.Now().Add(time.Minute).UnixMilli()}})
			return
		}
		if r.URL.Path != "/v1/device/"+uploadID+"/events" || r.Header.Get("Authorization") != "" || r.URL.Query().Get("workspace") != strings.Repeat("a", 64) || len(r.URL.Query()) != 1 || r.Header.Get("X-Openlaunch-Workspace") != strings.Repeat("a", 64) || strings.ReplaceAll(r.Header.Get("Sec-Websocket-Protocol"), " ", "") != deviceEventsProtocol+",ticket."+strings.Repeat("b", 64) {
			t.Error("event handshake exposed a credential or changed the protocol")
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{deviceEventsProtocol}})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		go func() {
			select {
			case <-work:
				conn.Write(ctx, websocket.MessageText, []byte(`{"type":"work"}`))
			case <-ctx.Done():
			}
		}()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if string(data) == "openlaunch.ping" {
				pings.Add(1)
				conn.Write(ctx, websocket.MessageText, []byte("openlaunch.pong"))
			}
		}
	}))
	defer server.Close()
	wake := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- deviceEventSession(ctx, eventFixtureConfig(server.URL), wake, 20*time.Millisecond, time.Second)
	}()
	awaitEvent(t, wake) // Subscription catch-up, without executing any command.
	close(work)
	awaitEvent(t, wake)
	deadline := time.Now().Add(time.Second)
	for pings.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if pings.Load() < 2 {
		t.Fatal("application ping/pong did not keep the connection alive")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("event shutdown blocked")
	}
}

func TestDeviceEventsReconnectWithFreshTickets(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var tickets syncatomic.Int32
	var sockets syncatomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "events-ticket") {
			tickets.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"ticket": strings.Repeat("b", 64), "expiresAt": time.Now().Add(time.Minute).UnixMilli()}})
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{deviceEventsProtocol}})
		if err != nil {
			return
		}
		sockets.Add(1)
		conn.CloseNow()
	}))
	defer server.Close()
	wake := startDeviceEvents(ctx, eventFixtureConfig(server.URL))
	awaitEvent(t, wake)
	awaitEvent(t, wake)
	if tickets.Load() < 2 || sockets.Load() < 2 {
		t.Fatal("reconnection did not acquire a fresh single-use ticket")
	}
	cancel()
}

func TestDeviceEventsFailClosedWithoutDisruptingPoller(t *testing.T) {
	for _, mode := range []string{"expired", "bad-ticket", "unauthorized", "redirect", "oversize", "no-pong", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			var upgrades syncatomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "events-ticket") {
					expiry := time.Now().Add(time.Minute).UnixMilli()
					ticket := strings.Repeat("b", 64)
					switch mode {
					case "expired":
						expiry = time.Now().Add(-time.Second).UnixMilli()
					case "bad-ticket":
						ticket = "private-device-credential"
					case "unauthorized":
						w.WriteHeader(401)
						return
					case "redirect":
						http.Redirect(w, r, "/unexpected-redirect", 307)
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"ticket": ticket, "expiresAt": expiry}})
					return
				}
				upgrades.Add(1)
				conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{deviceEventsProtocol}})
				if err != nil {
					return
				}
				defer conn.CloseNow()
				if mode == "oversize" {
					conn.Write(ctx, websocket.MessageText, []byte(strings.Repeat("x", 257)))
				}
				if mode == "unknown" {
					conn.Write(ctx, websocket.MessageText, []byte(`{"type":"execute","capability":"system.run"}`))
				}
				for {
					if _, _, err := conn.Read(ctx); err != nil {
						return
					}
				}
			}))
			defer server.Close()
			wake := make(chan struct{}, 4)
			err := deviceEventSession(ctx, eventFixtureConfig(server.URL), wake, 10*time.Millisecond, 30*time.Millisecond)
			if err == nil || strings.Contains(err.Error(), "private-device-credential") || strings.Contains(err.Error(), strings.Repeat("b", 64)) {
				t.Fatal("invalid event session succeeded or leaked credentials")
			}
			if mode == "expired" || mode == "bad-ticket" || mode == "unauthorized" || mode == "redirect" {
				if upgrades.Load() != 0 || len(wake) != 0 {
					t.Fatal("invalid ticket reached the event channel")
				}
			} else if len(wake) != 1 {
				t.Fatal("unknown or oversized frames produced extra work hints")
			}
		})
	}
}

// A subprocess exercises main's real polling, execution and durable receipt
// loop. Only the legacy Pi software health fixture is used; no hardware success
// is claimed and the server never supplies actions in a WebSocket frame.
func TestDeviceEventsRuntimeHelper(t *testing.T) {
	path := os.Getenv("OPENLAUNCH_EVENTS_TEST_CONFIG")
	if path == "" {
		return
	}
	os.Args = []string{"runtime-fixture", "--config", path}
	flag.CommandLine = flag.NewFlagSet("runtime-fixture", flag.ExitOnError)
	main()
	os.Exit(0)
}

func TestDeviceEventsWakeRealRuntimeBeforeFallbackPoll(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	work := make(chan struct{})
	subscribed := make(chan struct{})
	var polls syncatomic.Int32
	var queued syncatomic.Bool
	result := make(chan Outcome, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events-ticket") {
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"ticket": strings.Repeat("b", 64), "expiresAt": time.Now().Add(time.Minute).UnixMilli()}})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/events") {
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{deviceEventsProtocol}})
			if err != nil {
				return
			}
			defer conn.CloseNow()
			close(subscribed)
			select {
			case <-work:
			case <-ctx.Done():
				return
			}
			conn.Write(ctx, websocket.MessageText, []byte(`{"type":"work"}`))
			for {
				if _, _, err := conn.Read(ctx); err != nil {
					return
				}
			}
		}
		if r.Header.Get("Authorization") != "Bearer private-device-credential" {
			w.WriteHeader(401)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/next") {
			polls.Add(1)
			var command any
			if queued.CompareAndSwap(true, false) {
				command = Command{ID: uploadID, Capability: "device.health", Args: map[string]any{}, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
			}
			json.NewEncoder(w).Encode(map[string]any{"data": command})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/result") {
			var out Outcome
			if json.NewDecoder(r.Body).Decode(&out) != nil {
				t.Error("invalid runtime outcome")
			}
			json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": uploadID, "status": out.Status, "result": out.Result}})
			result <- out
			return
		}
		w.WriteHeader(404)
	}))
	defer server.Close()
	configPath := filepath.Join(t.TempDir(), "device.json")
	c := eventFixtureConfig(server.URL)
	c.Profile = ""
	c.Simulate = true
	if e := atomic(configPath, c); e != nil {
		t.Fatal(e)
	}
	program, _ := os.Executable()
	child := exec.Command(program, "-test.run=^TestDeviceEventsRuntimeHelper$")
	child.Env = append(os.Environ(), "OPENLAUNCH_EVENTS_TEST_CONFIG="+configPath)
	if e := child.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { child.Process.Kill(); child.Wait() })
	select {
	case <-subscribed:
	case <-time.After(3 * time.Second):
		t.Fatal("runtime did not subscribe")
	}
	deadline := time.Now().Add(3 * time.Second)
	for polls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if polls.Load() < 2 {
		t.Fatal("runtime did not perform subscription catch-up")
	}
	time.Sleep(100 * time.Millisecond) // Runtime is now waiting for the idle fallback.
	queued.Store(true)
	close(work)
	select {
	case out := <-result:
		if out.Status != "succeeded" || out.Result.(map[string]any)["simulated"] != true {
			t.Fatal("software health fixture failed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("native runtime waited for the ten-second fallback despite a work hint")
	}
	cancel()
}
