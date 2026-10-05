package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestControlOptInPreservesLegacyRevisionAndEnforcesExpiry(t *testing.T) {
	h, root, config := hostFixture(t, true)
	legacy, _ := json.Marshal(h.Policy)
	if strings.Contains(string(legacy), "control") {
		t.Fatal("upgrade changes legacy policy")
	}
	if out := h.Execute(Config{}, hostAction("system.exec", map[string]any{"command": "echo no"}), time.Now()); out.Status != "failed" {
		t.Fatal("shell enabled by default")
	}
	h.Policy.Control = &HostControl{Shell: true}
	t.Setenv("OPENLAUNCH_AGENT_TOKEN", "do-not-inherit")
	command := `printf '%s' "${OPENLAUNCH_AGENT_TOKEN-unset}"; printf owned > marker.txt; printf 'a\nb\n' | wc -l`
	r := hostCall(t, h, "system.exec", map[string]any{"command": command, "directory": root})
	b, e := os.ReadFile(filepath.Join(root, "marker.txt"))
	if e != nil || string(b) != "owned" || !strings.Contains(r["stdout"].(string), "unset") || r["exitCode"] != 0 {
		t.Fatal(r, e)
	}
	cmd := hostAction("system.exec", map[string]any{"command": "printf stale > stale.txt", "directory": root})
	cmd.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	if out := h.Execute(Config{}, cmd, time.Now()); out.Status != "failed" {
		t.Fatal("expired shell ran")
	}
	if _, e := os.Stat(filepath.Join(root, "stale.txt")); !os.IsNotExist(e) {
		t.Fatal("expired shell wrote data")
	}
	hostCall(t, h, "system.exec", map[string]any{"command": "exit 7"})
	p := h.Policy
	p.Control.Desktop = &HostDesktop{Backend: "wayland", Environment: map[string]string{"WAYLAND_DISPLAY": "wayland-0"}}
	p.Commands["uptime"] = HostCommand{Argv: []string{"/bin/echo", "fixed"}, TimeoutSeconds: 30}
	p.Services["worker"] = HostService{Unit: "worker.service", Actions: []string{"restart"}}
	if e = atomic(filepath.Join(h.State, "policy.json"), p); e != nil {
		t.Fatal(e)
	}
	next, e := newLinuxHarness(filepath.Join(h.State, "policy.json"), config)
	if e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	if next.Revision == h.Revision || len(next.Manifest().Capabilities) != 22 {
		t.Fatal("control manifest/revision missing")
	}
	for _, f := range next.Manifest().Functions {
		if len(f.Description) > 240 {
			t.Fatal(f.Name, "description too long")
		}
	}
	if e = checkControlBadEnvironment(next); e != nil {
		t.Fatal(e)
	}
}
func checkControlBadEnvironment(h *LinuxHarness) error {
	for _, env := range []map[string]string{{"WAYLAND_DISPLAY": "../remote"}, {"WAYLAND_DISPLAY": "wayland-0", "OPENAI_API_KEY": "secret"}, {"DISPLAY": "remote:0"}, {"DISPLAY": ":0", "XAUTHORITY": "relative"}} {
		if validateHostControl(&HostControl{Desktop: &HostDesktop{Backend: "wayland", Environment: env}}) == nil {
			return os.ErrInvalid
		}
	}
	return nil
}
func TestDesktopInputsRejectMissingOrIgnoredFieldsAndSafeKeyArguments(t *testing.T) {
	for _, a := range []map[string]any{{"operation": "click", "x": 1}, {"operation": "type", "text": "hi", "button": 1}, {"operation": "key", "key": "Return", "text": "extra"}} {
		if validateDesktopInput(a) == nil {
			t.Fatal("ambiguous input accepted", a)
		}
	}
	for _, chord := range []string{"Ctrl+Return", "Alt+Tab", "Ctrl+Shift+t"} {
		if _, e := keyboardArgs(chord, true); e != nil {
			t.Fatal(chord, e)
		}
	}
	for _, chord := range []string{"Ctrl+--help", "Ctrl+Alt+x;rm", "Unknown+Return", "Ctrl+Ctrl+x", ""} {
		if _, e := keyboardArgs(chord, true); e == nil {
			t.Fatal("invalid chord accepted", chord)
		}
	}
	h, _, _ := hostFixture(t, true)
	h.Policy.Control = &HostControl{Desktop: &HostDesktop{Backend: "wayland", Environment: map[string]string{"WAYLAND_DISPLAY": "wayland-missing-fixture"}}}
	status := hostCall(t, h, "desktop.status", map[string]any{})
	if status["available"] != false {
		t.Fatal("claimed nonexistent session")
	}
	if out := h.Execute(Config{}, hostAction("desktop.screenshot", map[string]any{}), time.Now()); out.Status != "failed" {
		t.Fatal("fake screenshot succeeded")
	}
}
func TestScreenshotPreviewBoundsRealImageAndDimensions(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 1920, 1080))
	rng := rand.New(rand.NewSource(5))
	for y := 0; y < 1080; y++ {
		for x := 0; x < 1920; x++ {
			source.SetRGBA(x, y, color.RGBA{uint8(rng.Intn(256)), uint8(rng.Intn(256)), uint8(rng.Intn(256)), 255})
		}
	}
	rect := image.Rect(200, 100, 1400, 900)
	encoded, width, height, e := desktopPreview(source, rect)
	if e != nil || len(encoded) > 32768 {
		t.Fatal(e, len(encoded))
	}
	decoded, e := jpeg.Decode(bytes.NewReader(encoded))
	if e != nil || decoded.Bounds().Dx() != width || decoded.Bounds().Dy() != height {
		t.Fatal("invalid JPEG", e)
	}
	if width > rect.Dx() || height > rect.Dy() {
		t.Fatal("bad dimensions")
	}
	envelope, _ := json.Marshal(map[string]any{"imageBase64": base64.StdEncoding.EncodeToString(encoded), "mimeType": "image/jpeg"})
	if len(envelope) > 48*1024 {
		t.Fatal("result envelope exceeded")
	}
}

// Opt-in software integration against a real headless labwc or Xvfb session.
// CI/container setups provide the compositor and helpers; this is not a Pi claim.
func TestActualDesktopSession(t *testing.T) {
	backend := os.Getenv("OPENLAUNCH_TEST_DESKTOP")
	if backend == "" {
		t.Skip("desktop acceptance needs an active test compositor")
	}
	h, _, _ := hostFixture(t, true)
	env := map[string]string{}
	if backend == "wayland" {
		env["WAYLAND_DISPLAY"] = os.Getenv("WAYLAND_DISPLAY")
	} else {
		env["DISPLAY"] = os.Getenv("DISPLAY")
	}
	h.Policy.Control = &HostControl{Shell: true, Desktop: &HostDesktop{Backend: backend, Environment: env}}
	if e := validateHostControl(h.Policy.Control); e != nil {
		t.Fatal(e)
	}
	status := hostCall(t, h, "desktop.status", map[string]any{})
	if status["available"] != true {
		t.Fatal(status)
	}
	screenshot := hostCall(t, h, "desktop.screenshot", map[string]any{})
	raw, e := base64.StdEncoding.DecodeString(screenshot["imageBase64"].(string))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = jpeg.Decode(bytes.NewReader(raw)); e != nil {
		t.Fatal(e)
	}
	for _, args := range []map[string]any{{"operation": "move", "x": 32767, "y": 32767}, {"operation": "click", "x": 32767, "y": 32767}, {"operation": "scroll", "steps": 2}, {"operation": "type", "text": "-safe leading option text"}, {"operation": "key", "key": "Ctrl+Return"}, {"operation": "key", "key": "Return"}} {
		t.Log("input", args["operation"])
		hostCall(t, h, "desktop.input", args)
	}
	hostCall(t, h, "desktop.screenshot", map[string]any{"x": 0, "y": 0, "width": 100, "height": 100})
}

func TestImageJournalCompactsOnlyAfterMatchingAcknowledgment(t *testing.T) {
	_, _, config := hostFixture(t, true)
	payload := map[string]any{"mimeType": "image/jpeg", "imageBase64": strings.Repeat("A", 40000)}
	cmd := hostAction("desktop.screenshot", map[string]any{})
	journal := map[string]JournalEntry{}
	calls := 0
	run := func(Config, Command, time.Time) Outcome { calls++; return Outcome{"succeeded", payload} }
	if e := processCommand(Config{}, cmd, time.Now(), journal, config+".journal", run); e != nil {
		t.Fatal(e)
	}
	before, _ := os.ReadFile(config + ".journal")
	if len(before) < 40000 {
		t.Fatal("image not persisted before reporting")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		json.NewDecoder(r.Body).Decode(&request)
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": cmd.ID, "status": "succeeded", "result": request["result"]}})
	}))
	defer server.Close()
	c := Config{URL: server.URL, Profile: "linux", DeviceID: cmd.ID}
	if e := reconcileResults(c, journal, config+".journal", time.Now().UnixMilli()); e != nil {
		t.Fatal(e)
	}
	after, _ := os.ReadFile(config + ".journal")
	if len(after) > 1024 || journal[cmd.ID].State != journalAcked {
		t.Fatal("acknowledged image not compacted")
	}
	saved, _, e := loadJournal(config + ".journal")
	if e != nil {
		t.Fatal(e)
	}
	if e = processCommand(c, cmd, time.Now(), saved, config+".journal", run); e != nil || calls != 1 {
		t.Fatal("compaction lost deduplication", e, calls)
	}
}

func TestTextFilesDoNotRequireAgentEncodingOrChecksumAndKeepRootBoundaries(t *testing.T) {
	h, root, _ := hostFixture(t, true)
	info := hostCall(t, h, "file.root_info", map[string]any{"root": "workspace"})
	if info["path"] != root || info["write"] != true {
		t.Fatal("root path unavailable", info)
	}
	// Crosses the private chunk boundary, with actual multibyte text.
	text := strings.Repeat("A story about a Pi: 🐧\n", 280)
	result := hostCall(t, h, "file.write_text", map[string]any{"root": "workspace", "path": "story.txt", "text": text})
	b, e := os.ReadFile(filepath.Join(root, "story.txt"))
	if e != nil || string(b) != text || result["sha256"] != sumText(text) {
		t.Fatal("text publication corrupted", result, e)
	}
	if out := h.Execute(Config{}, hostAction("file.write_text", map[string]any{"root": "workspace", "path": "story.txt", "text": "overwrite"}), time.Now()); out.Status != "failed" {
		t.Fatal("unapproved overwrite")
	}
	stat := hostCall(t, h, "file.stat", map[string]any{"root": "workspace", "path": "story.txt"})
	hostCall(t, h, "file.write_text", map[string]any{"root": "workspace", "path": "story.txt", "text": "", "replaceRevision": stat["revision"]})
	for _, path := range []string{"../private/stolen.txt", filepath.Join(root, "absolute.txt"), "missing/story.txt"} {
		if out := h.Execute(Config{}, hostAction("file.write_text", map[string]any{"root": "workspace", "path": path, "text": "denied"}), time.Now()); out.Status != "failed" {
			t.Fatal("unsafe text path", path)
		}
	}
	readonly, _, _ := hostFixture(t, false)
	if out := readonly.Execute(Config{}, hostAction("file.write_text", map[string]any{"root": "workspace", "path": "no.txt", "text": "denied"}), time.Now()); out.Status != "failed" {
		t.Fatal("read-only text write")
	}
	if out := h.Execute(Config{}, hostAction("file.write_text", map[string]any{"root": "workspace", "path": "too-big", "text": strings.Repeat("🐧", 3000)}), time.Now()); out.Status != "failed" {
		t.Fatal("byte ceiling missing")
	}
	entries, _ := os.ReadDir(h.State)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "upload-") {
			t.Fatal("text write left transfer debris", entry.Name())
		}
	}
}

func TestBrowserLauncherKeepsLiteralURLAndCleanEnvironmentAndSelectsSessionBackend(t *testing.T) {
	h, _, _ := hostFixture(t, true)
	t.Setenv("OPENAI_API_KEY", "must-not-forward")
	location := "https://example.org/?literal=$HOME&name=hello"
	for _, backend := range []string{"wayland", "x11"} {
		h.Policy.Control = &HostControl{Desktop: &HostDesktop{Backend: backend, Environment: map[string]string{}}}
		argv := h.browserLaunchArgv("/usr/bin/systemd-run", "/usr/bin/env", "/usr/bin/chromium", location, "openlaunch-browser-fixture.service")
		joined := strings.Join(argv, "\n")
		if !strings.Contains(joined, "--expand-environment=no") || !strings.Contains(joined, "--ozone-platform="+backend) || !strings.Contains(joined, "/usr/bin/env\n-i\n") || strings.Contains(joined, "must-not-forward") || argv[len(argv)-1] != location {
			t.Fatal("unsafe or wrong browser session", argv)
		}
	}
}
