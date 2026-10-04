package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	URL       string `json:"url"`
	Workspace string `json:"workspace"`
	DeviceID  string `json:"deviceId"`
	Token     string `json:"token"`
	Simulate  bool   `json:"simulate"`
}
type Command struct {
	ID         string         `json:"id"`
	Capability string         `json:"capability"`
	Args       map[string]any `json:"args"`
	ExpiresAt  int64          `json:"expiresAt"`
}
type Outcome struct {
	Status string `json:"status"`
	Result any    `json:"result"`
}

var httpClient = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return errors.New("redirects are not allowed") }}

func validateURL(s string) error {
	u, e := url.Parse(s)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return errors.New("use a bare HTTPS origin")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "127.0.0.1") {
		return errors.New("HTTPS required, except literal loopback for local tests")
	}
	return nil
}
func call(c Config, path string, input any, out any) error {
	var data []byte
	if input != nil {
		var e error
		data, e = json.Marshal(input)
		if e != nil {
			return e
		}
	}
	r, e := http.NewRequest("POST", strings.TrimRight(c.URL, "/")+path, bytes.NewReader(data))
	if e != nil {
		return e
	}
	r.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		r.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if c.Workspace != "" {
		r.Header.Set("x-openlaunch-workspace", c.Workspace)
	}
	response, e := httpClient.Do(r)
	if e != nil {
		return e
	}
	defer response.Body.Close()
	body, e := io.ReadAll(io.LimitReader(response.Body, 16385))
	if e != nil {
		return e
	}
	if len(body) > 16384 {
		return errors.New("response too large")
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("server returned HTTP %d", response.StatusCode)
	}
	if out != nil {
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		if e = json.Unmarshal(body, &envelope); e != nil {
			return e
		}
		return json.Unmarshal(envelope.Data, out)
	}
	return nil
}
func atomic(path string, data any) error {
	b, e := json.MarshalIndent(data, "", "  ")
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	tmp := path + ".tmp"
	f, e := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(tmp, path)
}
func execute(c Config, cmd Command, started time.Time) Outcome {
	if time.Now().UnixMilli() >= cmd.ExpiresAt {
		return Outcome{"failed", map[string]any{"error": "expired_before_execution"}}
	}
	switch cmd.Capability {
	case "device.health":
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		return Outcome{"succeeded", map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "uptimeSeconds": int(time.Since(started).Seconds()), "processAllocatedBytes": m.Alloc, "simulated": c.Simulate}}
	}
	if c.Simulate && (cmd.Capability == "display.text" || cmd.Capability == "led.set") {
		return Outcome{"succeeded", map[string]any{"simulated": true, "applied": cmd.Args}}
	}
	return Outcome{"failed", map[string]any{"error": "unsupported_capability"}}
}
func main() {
	configPath := flag.String("config", "./device.json", "credential file (keep outside Git)")
	base := flag.String("url", "", "HTTPS server origin for enrollment")
	workspace := flag.String("workspace", "", "cloud workspace id for enrollment")
	enroll := flag.Bool("enroll", false, "enroll using OPENLAUNCH_ENROLLMENT_TOKEN in environment")
	simulate := flag.Bool("simulate", false, "explicitly simulated display and LED")
	once := flag.Bool("once", false, "poll once")
	flag.Parse()
	if *enroll {
		if e := validateURL(*base); e != nil {
			fatal(e)
		}
		if _, e := os.Stat(*configPath); e == nil {
			fatal(errors.New("config exists; refuse overwriting device identity"))
		}
		token := os.Getenv("OPENLAUNCH_ENROLLMENT_TOKEN")
		if token == "" {
			fatal(errors.New("set OPENLAUNCH_ENROLLMENT_TOKEN"))
		}
		caps := []string{"device.health"}
		if *simulate {
			caps = append(caps, "display.text", "led.set")
		}
		c := Config{URL: *base, Workspace: *workspace, Simulate: *simulate}
		var identity struct {
			DeviceID string `json:"deviceId"`
			Token    string `json:"token"`
		}
		if e := call(c, "/v1/device/enroll", map[string]any{"token": token, "manifest": map[string]any{"name": "pi-4", "kind": "raspberry-pi-4", "capabilities": caps}}, &identity); e != nil {
			fatal(e)
		}
		c.DeviceID = identity.DeviceID
		c.Token = identity.Token
		if e := atomic(*configPath, c); e != nil {
			fatal(e)
		}
		fmt.Println("Enrolled device", c.DeviceID)
		return
	}
	b, e := os.ReadFile(*configPath)
	if e != nil {
		fatal(e)
	}
	var c Config
	if e = json.Unmarshal(b, &c); e != nil {
		fatal(e)
	}
	if e = validateURL(c.URL); e != nil {
		fatal(e)
	}
	if c.DeviceID == "" || c.Token == "" {
		fatal(errors.New("invalid config"))
	}
	journal := map[string]Outcome{}
	journalPath := *configPath + ".journal"
	if b, e = os.ReadFile(journalPath); e == nil {
		if e = json.Unmarshal(b, &journal); e != nil {
			fatal(errors.New("invalid journal: refusing device execution"))
		}
	}
	started := time.Now()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	for {
		var cmd *Command
		e = call(c, "/v1/device/"+c.DeviceID+"/next", map[string]any{}, &cmd)
		if e != nil {
			fmt.Fprintln(os.Stderr, "poll:", e)
		} else if cmd != nil {
			out, seen := journal[cmd.ID]
			if !seen {
				if len(journal) >= 5000 {
					fatal(errors.New("journal retention limit reached; archive safely before restarting"))
				}
				journal[cmd.ID] = Outcome{"unknown", map[string]any{"error": "interrupted_execution"}}
				if e = atomic(journalPath, journal); e != nil {
					fatal(e)
				}
				out = execute(c, *cmd, started)
				journal[cmd.ID] = out
				if e = atomic(journalPath, journal); e != nil {
					fatal(e)
				}
			}
			if out.Status != "unknown" {
				e = call(c, "/v1/device/"+c.DeviceID+"/result", map[string]any{"actionId": cmd.ID, "status": out.Status, "result": out.Result}, nil)
				if e != nil {
					fmt.Fprintln(os.Stderr, "result delivery uncertain:", e)
				}
			}
		}
		if *once {
			return
		}
		select {
		case <-stop:
			return
		case <-time.After(10 * time.Second):
		}
	}
}
func fatal(e error) { fmt.Fprintln(os.Stderr, e); os.Exit(1) }
