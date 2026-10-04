package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
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
type Manifest struct {
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Capabilities []string `json:"capabilities"`
}

// AttachPending contains only retry metadata. In particular, it never contains
// the owner-created SDK token. Keeping the exact request lets a restart reuse
// the server's short idempotency window after a lost response.
type AttachPending struct {
	Version   int      `json:"version"`
	URL       string   `json:"url"`
	Workspace string   `json:"workspace"`
	RequestID string   `json:"requestId"`
	Manifest  Manifest `json:"manifest"`
	Simulate  bool     `json:"simulate"`
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
var errAttachmentExpired = errors.New("attachment retry expired; check device inventory before starting another request")

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
		var fault struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &fault) == nil && fault.Error.Code == "attachment_expired" {
			return errAttachmentExpired
		}
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
	f, e := os.CreateTemp(filepath.Dir(path), ".openlaunch-*.tmp")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e != nil {
		f.Close()
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

func sdkTokenWorkspace(token string) (string, error) {
	parts := strings.Split(token, "_")
	if len(parts) != 4 || parts[0] != "ol" || (parts[1] != "sdk" && parts[1] != "agent") ||
		!isLowerHex(parts[2], 64) || !isLowerHex(parts[3], 64) {
		return "", errors.New("set OPENLAUNCH_SDK_TOKEN to an owner-issued SDK token")
	}
	return parts[2], nil
}

func isLowerHex(value string, size int) bool {
	if len(value) != size {
		return false
	}
	for _, ch := range value {
		if !(ch >= '0' && ch <= '9') && !(ch >= 'a' && ch <= 'f') {
			return false
		}
	}
	return true
}

func newRequestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func pathExists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func readAttachPending(path string) (AttachPending, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return AttachPending{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return AttachPending{}, errors.New("pending attachment must be a private regular file")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return AttachPending{}, err
	}
	var pending AttachPending
	if err := json.Unmarshal(b, &pending); err != nil {
		return AttachPending{}, errors.New("invalid pending attachment; refusing to continue")
	}
	if pending.Version != 1 || pending.URL == "" || !isLowerHex(pending.Workspace, 64) ||
		!isUUID(pending.RequestID) || pending.Manifest.Name == "" || pending.Manifest.Kind == "" ||
		len(pending.Manifest.Capabilities) == 0 {
		return AttachPending{}, errors.New("invalid pending attachment; refusing to continue")
	}
	if err := validateURL(pending.URL); err != nil {
		return AttachPending{}, errors.New("invalid pending attachment origin; refusing to continue")
	}
	expected := []string{"device.health"}
	if pending.Simulate {
		expected = append(expected, "display.text", "led.set")
	}
	if pending.Manifest.Name != "pi-4" || pending.Manifest.Kind != "raspberry-pi-4" || len(pending.Manifest.Capabilities) != len(expected) {
		return AttachPending{}, errors.New("invalid pending Pi manifest; refusing to continue")
	}
	for i := range expected {
		if pending.Manifest.Capabilities[i] != expected[i] {
			return AttachPending{}, errors.New("invalid pending Pi manifest; refusing to continue")
		}
	}
	return pending, nil
}

func isUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for i, ch := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !(ch >= '0' && ch <= '9') && !(ch >= 'a' && ch <= 'f') && !(ch >= 'A' && ch <= 'F') {
			return false
		}
	}
	return true
}

func attachDevice(base, configPath, token string, simulate bool) error {
	workspace, err := sdkTokenWorkspace(token)
	if err != nil {
		return err
	}
	if err := validateURL(base); err != nil {
		return err
	}
	if exists, err := pathExists(configPath); err != nil {
		return err
	} else if exists {
		return errors.New("config exists; refuse overwriting device identity")
	}
	pendingPath := configPath + ".attach-pending"
	expiredPath := pendingPath + ".expired"
	if exists, err := pathExists(expiredPath); err != nil {
		return err
	} else if exists {
		return errAttachmentExpired
	}
	var pending AttachPending
	if exists, err := pathExists(pendingPath); err != nil {
		return err
	} else if exists {
		pending, err = readAttachPending(pendingPath)
		if err != nil {
			return err
		}
		if pending.URL != base || pending.Workspace != workspace || pending.Simulate != simulate {
			return errors.New("pending attachment belongs to a different URL, workspace or mode")
		}
	} else {
		caps := []string{"device.health"}
		if simulate {
			caps = append(caps, "display.text", "led.set")
		}
		requestID, err := newRequestID()
		if err != nil {
			return err
		}
		pending = AttachPending{
			Version: 1, URL: base, Workspace: workspace, RequestID: requestID,
			Manifest: Manifest{Name: "pi-4", Kind: "raspberry-pi-4", Capabilities: caps}, Simulate: simulate,
		}
		if err := atomic(pendingPath, pending); err != nil {
			return fmt.Errorf("could not save private attachment retry metadata: %w", err)
		}
	}

	// The shared HTTP helper uses Config.Token for the bearer header. This
	// in-memory value is replaced with the child credential before persistence.
	c := Config{URL: pending.URL, Workspace: pending.Workspace, Token: token, Simulate: pending.Simulate}
	var identity struct {
		DeviceID string `json:"deviceId"`
		Token    string `json:"token"`
	}
	if err := call(c, "/v1/sdk/devices", map[string]any{"requestId": pending.RequestID, "manifest": pending.Manifest}, &identity); err != nil {
		if errors.Is(err, errAttachmentExpired) {
			// Renaming prevents a later installer run from silently issuing the
			// expired request again. An owner must inspect inventory first.
			if renameErr := os.Rename(pendingPath, expiredPath); renameErr != nil {
				return fmt.Errorf("%w; could not mark the request expired: %v", errAttachmentExpired, renameErr)
			}
		}
		return err
	}
	if identity.DeviceID == "" || identity.Token == "" {
		return errors.New("server returned an invalid device identity")
	}
	c.DeviceID = identity.DeviceID
	c.Token = identity.Token
	if err := atomic(configPath, c); err != nil {
		return err
	}
	if err := os.Remove(pendingPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("device credential saved, but pending metadata could not be removed: %w", err)
	}
	return nil
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
	attach := flag.Bool("attach", false, "attach with OPENLAUNCH_SDK_TOKEN")
	enroll := flag.Bool("enroll", false, "enroll using OPENLAUNCH_ENROLLMENT_TOKEN in environment")
	simulate := flag.Bool("simulate", false, "explicitly simulated display and LED")
	once := flag.Bool("once", false, "poll once")
	flag.Parse()
	if *attach && *enroll {
		fatal(errors.New("choose either --attach or legacy --enroll"))
	}
	if *attach {
		if e := attachDevice(*base, *configPath, os.Getenv("OPENLAUNCH_SDK_TOKEN"), *simulate); e != nil {
			fatal(e)
		}
		b, e := os.ReadFile(*configPath)
		if e != nil {
			fatal(e)
		}
		var c Config
		if e = json.Unmarshal(b, &c); e != nil {
			fatal(e)
		}
		fmt.Println("Attached device", c.DeviceID)
		return
	}
	if *enroll {
		if e := validateURL(*base); e != nil {
			fatal(e)
		}
		if exists, e := pathExists(*configPath); e != nil {
			fatal(e)
		} else if exists {
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
