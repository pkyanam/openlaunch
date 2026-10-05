package main

import (
	"bytes"
	"context"
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
	"sort"
	"strconv"
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
	Profile   string `json:"profile,omitempty"`
	Policy    string `json:"policy,omitempty"`
}
type Manifest struct {
	Name         string               `json:"name"`
	Kind         string               `json:"kind"`
	Capabilities []string             `json:"capabilities"`
	Functions    []FunctionDefinition `json:"functions,omitempty"`
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

type JournalEntry struct {
	State         string  `json:"state"`
	ExpiresAt     int64   `json:"expiresAt"`
	Outcome       Outcome `json:"outcome"`
	RetryCount    int     `json:"retryCount,omitempty"`
	NextAttemptAt int64   `json:"nextAttemptAt,omitempty"`
}

type JournalFile struct {
	Version int                     `json:"version"`
	Entries map[string]JournalEntry `json:"entries"`
}

const (
	journalUnknown = "unknown"
	journalPending = "result_pending"
	journalAcked   = "acknowledged"
)

var errInterruptedUnknown = errors.New("an interrupted action has unknown outcome; refusing replay and new commands")
var errReceiptMismatch = errors.New("server returned a mismatched action result receipt")

type httpStatusError struct {
	StatusCode int
	RetryAfter time.Duration
}

func (e httpStatusError) Error() string { return fmt.Sprintf("server returned HTTP %d", e.StatusCode) }

type responseDecodeError struct{ Err error }

func (e responseDecodeError) Error() string { return "invalid server response: " + e.Err.Error() }
func (e responseDecodeError) Unwrap() error { return e.Err }

type resultDeliveryError struct {
	ActionID   string
	Terminal   bool
	RetryAfter time.Duration
	Err        error
}

func (e resultDeliveryError) Error() string {
	return fmt.Sprintf("result delivery for %s: %v", e.ActionID, e.Err)
}
func (e resultDeliveryError) Unwrap() error { return e.Err }

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
	return callContext(context.Background(), c, path, input, out)
}
func callContext(ctx context.Context, c Config, path string, input any, out any) error {
	var data []byte
	if input != nil {
		var e error
		data, e = json.Marshal(input)
		if e != nil {
			return e
		}
	}
	r, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.URL, "/")+path, bytes.NewReader(data))
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
	responseLimit := int64(16384)
	if c.Profile == "linux" {
		responseLimit = 65536
	}
	body, e := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if e != nil {
		return e
	}
	if int64(len(body)) > responseLimit {
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
		return httpStatusError{
			StatusCode: response.StatusCode,
			RetryAfter: parseRetryAfter(response.Header.Get("Retry-After"), time.Now()),
		}
	}
	if out != nil {
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		if e = json.Unmarshal(body, &envelope); e != nil {
			return responseDecodeError{Err: e}
		}
		if e = json.Unmarshal(envelope.Data, out); e != nil {
			return responseDecodeError{Err: e}
		}
	}
	return nil
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
		if seconds < 0 {
			return 0
		}
		const maxSeconds = int64((24 * time.Hour) / time.Second)
		if seconds > maxSeconds {
			seconds = maxSeconds
		}
		return time.Duration(seconds) * time.Second
	}
	if retryAt, err := http.ParseTime(value); err == nil {
		delay := retryAt.Sub(now)
		if delay < 0 {
			return 0
		}
		if delay > 24*time.Hour {
			return 24 * time.Hour
		}
		return delay
	}
	return 0
}

func resultRetryDelay(retryCount int, retryAfter time.Duration, expiresAt, nowMS int64) (time.Duration, int64, bool) {
	if expiresAt <= nowMS {
		return 0, 0, false
	}
	attempt := retryCount - 1
	if attempt < 0 {
		attempt = 0
	}
	if attempt > 6 {
		attempt = 6
	}
	delay := time.Second << attempt
	if delay > time.Minute {
		delay = time.Minute
	}
	if retryAfter > delay {
		delay = retryAfter
	}
	remaining := time.Duration(expiresAt-nowMS) * time.Millisecond
	// Keep the retry strictly ahead of the server action deadline; using the
	// full remaining TTL could wake only after the result can no longer apply.
	deadlineBudget := remaining - time.Millisecond
	if delay > deadlineBudget {
		delay = deadlineBudget
	}
	if delay <= 0 {
		return 0, 0, false
	}
	return delay, nowMS + delay.Milliseconds(), true
}

func resultRetryWait(err error) time.Duration {
	var delivery resultDeliveryError
	if errors.As(err, &delivery) && delivery.RetryAfter > 0 {
		return delivery.RetryAfter
	}
	return 10 * time.Second
}

func haltOnResultError(err error) bool {
	var delivery resultDeliveryError
	return errors.As(err, &delivery) && delivery.Terminal || errors.Is(err, errInterruptedUnknown)
}

func canonicalJSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var normalized any
	if err := json.Unmarshal(raw, &normalized); err != nil {
		return nil, err
	}
	return json.Marshal(normalized)
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
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}

func validateJournal(entries map[string]JournalEntry) error {
	if len(entries) > 5000 {
		return errors.New("journal retention limit reached; archive safely before restarting")
	}
	for id, entry := range entries {
		if !isUUID(id) || entry.ExpiresAt < 0 || entry.RetryCount < 0 || entry.NextAttemptAt < 0 {
			return errors.New("invalid journal: refusing device execution")
		}
		switch entry.State {
		case journalUnknown:
			if entry.Outcome.Status != "unknown" {
				return errors.New("invalid journal: refusing device execution")
			}
		case journalPending, journalAcked:
			if entry.Outcome.Status != "succeeded" && entry.Outcome.Status != "failed" {
				return errors.New("invalid journal: refusing device execution")
			}
		default:
			return errors.New("invalid journal: refusing device execution")
		}
	}
	return nil
}

// loadJournal reads the current version or safely maps the previous flat
// map[actionID]Outcome format. Legacy completed outcomes remain pending so the
// server can idempotently acknowledge them; a legacy unknown stays ambiguous.
func loadJournal(path string) (map[string]JournalEntry, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]JournalEntry{}, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, false, errors.New("journal must be a private regular file")
	}
	if info.Size() > 25*1024*1024 {
		return nil, false, errors.New("journal exceeds the safe size limit; refusing device execution")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	var current JournalFile
	if json.Unmarshal(b, &current) == nil && current.Version == 1 && current.Entries != nil {
		if err := validateJournal(current.Entries); err != nil {
			return nil, false, err
		}
		return current.Entries, false, nil
	}
	var legacy map[string]Outcome
	if err := json.Unmarshal(b, &legacy); err != nil || legacy == nil {
		return nil, false, errors.New("invalid journal: refusing device execution")
	}
	entries := make(map[string]JournalEntry, len(legacy))
	for id, outcome := range legacy {
		switch outcome.Status {
		case "unknown":
			entries[id] = JournalEntry{State: journalUnknown, Outcome: outcome}
		case "succeeded", "failed":
			entries[id] = JournalEntry{State: journalPending, Outcome: outcome}
		default:
			return nil, false, errors.New("invalid legacy journal: refusing device execution")
		}
	}
	if err := validateJournal(entries); err != nil {
		return nil, false, err
	}
	return entries, true, nil
}

func saveJournal(path string, entries map[string]JournalEntry) error {
	if err := validateJournal(entries); err != nil {
		return err
	}
	return atomic(path, JournalFile{Version: 1, Entries: entries})
}

func processCommand(c Config, cmd Command, started time.Time, journal map[string]JournalEntry, journalPath string, run func(Config, Command, time.Time) Outcome) error {
	if _, seen := journal[cmd.ID]; seen {
		return nil
	}
	if len(journal) >= 5000 {
		return errors.New("journal retention limit reached; archive safely before restarting")
	}
	entry := JournalEntry{
		State: journalUnknown, ExpiresAt: cmd.ExpiresAt,
		Outcome: Outcome{Status: "unknown", Result: map[string]any{"error": "interrupted_execution"}},
	}
	journal[cmd.ID] = entry
	if err := saveJournal(journalPath, journal); err != nil {
		delete(journal, cmd.ID)
		return err
	}

	entry.Outcome = run(c, cmd, started)
	entry.State = journalPending
	journal[cmd.ID] = entry
	if err := saveJournal(journalPath, journal); err != nil {
		// The disk still says unknown. Keep that safer state in memory too.
		entry.State = journalUnknown
		entry.Outcome = Outcome{Status: "unknown", Result: map[string]any{"error": "interrupted_execution"}}
		journal[cmd.ID] = entry
		return err
	}
	return nil
}

func reconcileResults(c Config, journal map[string]JournalEntry, journalPath string, nowMS int64) error {
	ids := make([]string, 0, len(journal))
	for id := range journal {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	interruptedUnknown := ""
	var deferred *resultDeliveryError
	for _, id := range ids {
		entry := journal[id]
		if entry.State == journalUnknown {
			if interruptedUnknown == "" {
				interruptedUnknown = id
			}
			continue
		}
		if entry.State != journalPending {
			continue
		}
		if entry.NextAttemptAt > nowMS {
			candidate := resultDeliveryError{
				ActionID: id, RetryAfter: time.Duration(entry.NextAttemptAt-nowMS) * time.Millisecond,
				Err: errors.New("result retry is waiting for its saved backoff"),
			}
			if deferred == nil || candidate.RetryAfter < deferred.RetryAfter {
				deferred = &candidate
			}
			continue
		}
		var receipt struct {
			ID     string          `json:"id"`
			Status string          `json:"status"`
			Result json.RawMessage `json:"result"`
		}
		err := call(c, "/v1/device/"+c.DeviceID+"/result", map[string]any{
			"actionId": id, "status": entry.Outcome.Status, "result": entry.Outcome.Result,
		}, &receipt)
		if err != nil {
			terminal := false
			var statusErr httpStatusError
			var decodeErr responseDecodeError
			if errors.As(err, &statusErr) {
				if statusErr.StatusCode == http.StatusRequestTimeout || statusErr.StatusCode == http.StatusTooManyRequests {
					retryNowMS := time.Now().UnixMilli()
					entry.RetryCount++
					delay, nextAttemptAt, canRetry := resultRetryDelay(entry.RetryCount, statusErr.RetryAfter, entry.ExpiresAt, retryNowMS)
					if !canRetry {
						return resultDeliveryError{ActionID: id, Terminal: true, Err: errors.New("result retry window expired; outcome retained in the device journal")}
					}
					previous := journal[id]
					entry.NextAttemptAt = nextAttemptAt
					journal[id] = entry
					if saveErr := saveJournal(journalPath, journal); saveErr != nil {
						journal[id] = previous
						return resultDeliveryError{ActionID: id, Terminal: true, Err: fmt.Errorf("could not persist result backoff: %w", saveErr)}
					}
					candidate := resultDeliveryError{
						ActionID: id, RetryAfter: delay,
						Err: fmt.Errorf("HTTP %d; retry scheduled", statusErr.StatusCode),
					}
					if deferred == nil || candidate.RetryAfter < deferred.RetryAfter {
						deferred = &candidate
					}
					continue
				}
				terminal = statusErr.StatusCode >= 400 && statusErr.StatusCode < 500
			}
			if errors.As(err, &decodeErr) {
				terminal = true
			}
			return resultDeliveryError{ActionID: id, Terminal: terminal, Err: err}
		}
		receiptResult, resultErr := canonicalJSON(receipt.Result)
		outcomeResult, outcomeErr := canonicalJSON(entry.Outcome.Result)
		if receipt.ID != id || receipt.Status != entry.Outcome.Status || len(receipt.Result) == 0 || resultErr != nil || outcomeErr != nil || !bytes.Equal(receiptResult, outcomeResult) {
			return resultDeliveryError{ActionID: id, Terminal: true, Err: errReceiptMismatch}
		}
		previous := entry
		entry.State = journalAcked
		// The server now owns the complete image receipt. Keep a deduplication
		// tombstone locally rather than retaining tens of KiB per screenshot.
		if c.Profile == "linux" {
			if result, ok := entry.Outcome.Result.(map[string]any); ok && result["mimeType"] == "image/jpeg" {
				if _, image := result["imageBase64"].(string); image {
					entry.Outcome.Result = map[string]any{"receiptStored": true}
				}
			}
		}
		entry.RetryCount = 0
		entry.NextAttemptAt = 0
		journal[id] = entry
		if err := saveJournal(journalPath, journal); err != nil {
			journal[id] = previous
			return fmt.Errorf("could not persist action result receipt: %w", err)
		}
	}
	if interruptedUnknown != "" {
		return fmt.Errorf("%w: action %s", errInterruptedUnknown, interruptedUnknown)
	}
	if deferred != nil {
		return *deferred
	}
	return nil
}

func sdkTokenWorkspace(token string) (string, error) {
	parts := strings.Split(token, "_")
	if len(parts) != 4 || parts[0] != "ol" || parts[1] != "sdk" ||
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
	if pending.Manifest.Kind == "linux" && !pending.Simulate {
		// The caller also compares this saved manifest with the current local policy.
		return pending, nil
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

func attachDevice(base, configPath, token string, simulate bool, linuxPolicy ...string) error {
	var hostManifest *Manifest
	policyPath := ""
	if len(linuxPolicy) > 0 {
		if simulate {
			return errors.New("Linux host controls cannot be simulated")
		}
		policyPath = linuxPolicy[0]
		var pathErr error
		policyPath, pathErr = filepath.Abs(policyPath)
		if pathErr != nil {
			return pathErr
		}
		h, e := newLinuxHarness(policyPath, configPath)
		if e != nil {
			return e
		}
		defer h.Close()
		m := h.Manifest()
		hostManifest = &m
	}
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
		if hostManifest != nil {
			old, _ := json.Marshal(pending.Manifest)
			current, _ := json.Marshal(hostManifest)
			if !bytes.Equal(old, current) {
				return errors.New("pending attachment policy changed; restore the original policy before retrying")
			}
		} else if pending.Manifest.Kind == "linux" {
			return errors.New("pending attachment uses the Linux profile")
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
		if hostManifest != nil {
			pending.Manifest = *hostManifest
		}
		if err := atomic(pendingPath, pending); err != nil {
			return fmt.Errorf("could not save private attachment retry metadata: %w", err)
		}
	}

	// The shared HTTP helper uses Config.Token for the bearer header. This
	// in-memory value is replaced with the child credential before persistence.
	c := Config{URL: pending.URL, Workspace: pending.Workspace, Token: token, Simulate: pending.Simulate}
	if hostManifest != nil {
		c.Profile = "linux"
		c.Policy = policyPath
	}
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
	defaultConfig := "./device.json"
	if filepath.Base(os.Args[0]) == "openlaunch-host" {
		defaultConfig = hostConfigPath()
		if hostCLI(os.Args[1:], defaultConfig) {
			return
		}
	}
	configPath := flag.String("config", defaultConfig, "credential file (keep outside Git)")
	profile := flag.String("profile", "", "linux enables locally configured host functions")
	policy := flag.String("policy", "", "private Linux policy file; defaults alongside config")
	initHost := flag.Bool("linux-init", false, "create a private default Linux policy and workspace")
	checkConfig := flag.Bool("check-config", false, "validate a saved Linux configuration without network access or execution")
	base := flag.String("url", "", "HTTPS server origin for enrollment")
	workspace := flag.String("workspace", "", "cloud workspace id for enrollment")
	attach := flag.Bool("attach", false, "attach with OPENLAUNCH_SDK_TOKEN")
	enroll := flag.Bool("enroll", false, "enroll using OPENLAUNCH_ENROLLMENT_TOKEN in environment")
	simulate := flag.Bool("simulate", false, "explicitly simulated display and LED")
	once := flag.Bool("once", false, "poll once")
	flag.Parse()
	if *policy == "" {
		*policy = filepath.Join(filepath.Dir(*configPath), "policy.json")
	}
	if *initHost {
		if e := initLinuxPolicy(*policy, *configPath); e != nil {
			fatal(e)
		}
		return
	}
	if *checkConfig {
		if e := checkLinuxConfig(*configPath); e != nil {
			fatal(e)
		}
		fmt.Println("Saved Linux identity, policy and journal are valid.")
		return
	}
	if *profile != "" && *profile != "linux" {
		fatal(errors.New("unknown profile"))
	}
	if *profile == "linux" && (runtime.GOOS != "linux" || *simulate || *enroll) {
		fatal(errors.New("Linux profile requires Linux and SDK attachment; simulation is unsupported"))
	}
	if *attach && *enroll {
		fatal(errors.New("choose either --attach or legacy --enroll"))
	}
	if *attach {
		var policies []string
		if *profile == "linux" {
			policies = []string{*policy}
		}
		if e := attachDevice(*base, *configPath, os.Getenv("OPENLAUNCH_SDK_TOKEN"), *simulate, policies...); e != nil {
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
	run := execute
	var harness *LinuxHarness
	if c.Profile == "linux" {
		if runtime.GOOS != "linux" || os.Geteuid() == 0 {
			fatal(errors.New("run the Linux harness as an unprivileged Linux user"))
		}
		harness, e = newLinuxHarness(c.Policy, *configPath)
		if e != nil {
			fatal(e)
		}
		defer harness.Close()
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		harness.Context = ctx
		lock, lockErr := acquireHostLock(harness.State)
		if lockErr != nil {
			fatal(lockErr)
		}
		defer lock.Close()
		run = harness.Execute
	} else if c.Profile != "" {
		fatal(errors.New("unknown saved profile"))
	}
	journalPath := *configPath + ".journal"
	journal, migrated, e := loadJournal(journalPath)
	if e != nil {
		fatal(e)
	}
	if migrated {
		if e = saveJournal(journalPath, journal); e != nil {
			fatal(fmt.Errorf("could not safely migrate device journal: %w", e))
		}
	}
	if harness != nil {
		if e = reconcileResults(c, journal, journalPath, time.Now().UnixMilli()); e != nil {
			fatal(e)
		}
		var receipt struct {
			GrantsRevoked bool `json:"grantsRevoked"`
		}
		if e = call(c, "/v1/device/"+c.DeviceID+"/manifest", map[string]any{"manifest": harness.Manifest()}, &receipt); e != nil {
			fatal(e)
		}
		if receipt.GrantsRevoked {
			fmt.Println("Local policy changed. Reapprove this device's function grants in the console.")
		}
	}
	started := time.Now()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(stop)
	eventsContext, cancelEvents := context.WithCancel(context.Background())
	defer cancelEvents()
	var wake <-chan struct{}
	if !*once {
		wake = startDeviceEvents(eventsContext, c)
	}
	for {
		if e = reconcileResults(c, journal, journalPath, time.Now().UnixMilli()); e != nil {
			if haltOnResultError(e) {
				fatal(e)
			}
			fmt.Fprintln(os.Stderr, "result delivery retry pending:", e)
			if *once {
				return
			}
			select {
			case <-stop:
				return
			case <-time.After(resultRetryWait(e)):
			}
			continue
		}
		waitBeforeNextPoll := 10 * time.Second
		allowWake := wake
		var cmd *Command
		e = call(c, "/v1/device/"+c.DeviceID+"/next", map[string]any{}, &cmd)
		if e != nil {
			fmt.Fprintln(os.Stderr, "poll:", e)
		} else if cmd != nil {
			operation := func() error { return processCommand(c, *cmd, started, journal, journalPath, run) }
			if harness != nil {
				e = withDevicePresence(harness.Context, c, 20*time.Second, operation)
			} else {
				e = operation()
			}
			if e != nil {
				fatal(e)
			}
			if e = reconcileResults(c, journal, journalPath, time.Now().UnixMilli()); e != nil {
				if haltOnResultError(e) {
					fatal(e)
				}
				fmt.Fprintln(os.Stderr, "result delivery retry pending:", e)
				waitBeforeNextPoll = resultRetryWait(e)
				// Hints never bypass durable result reconciliation or its backoff.
				allowWake = nil
			} else {
				// Drain queued work promptly after its durable result is acknowledged.
				// Idle/error polling stays at ten seconds; do not amplify idle cost.
				waitBeforeNextPoll = 100 * time.Millisecond
			}
		}
		if *once {
			return
		}
		select {
		case <-stop:
			return
		case <-allowWake:
		case <-time.After(waitBeforeNextPoll):
		}
	}
}
func fatal(e error) { fmt.Fprintln(os.Stderr, e); os.Exit(1) }
