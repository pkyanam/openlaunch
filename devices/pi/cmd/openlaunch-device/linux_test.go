package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const uploadID = "ab937405-1a8d-43b9-8c74-614f9cfe8b28"

func hostFixture(t *testing.T, write bool) (*LinuxHarness, string, string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(base, "private")
	root := filepath.Join(base, "workspace")
	if e := os.Mkdir(state, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.Mkdir(root, 0700); e != nil {
		t.Fatal(e)
	}
	p := HostPolicy{1, "test-host", map[string]HostRoot{"workspace": {root, write}}, map[string]HostCommand{}, map[string]HostService{}}
	config := filepath.Join(state, "device.json")
	policy := filepath.Join(state, "policy.json")
	if e := atomic(policy, p); e != nil {
		t.Fatal(e)
	}
	h, e := newLinuxHarness(policy, config)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(h.Close)
	return h, root, config
}
func hostAction(name string, args map[string]any) Command {
	return Command{ID: uploadID, Capability: name, Args: args, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
}
func hostCall(t *testing.T, h *LinuxHarness, name string, args map[string]any) map[string]any {
	t.Helper()
	out := h.Execute(Config{}, hostAction(name, args), time.Now())
	if out.Status != "succeeded" {
		t.Fatalf("%s: %+v", name, out)
	}
	return out.Result.(map[string]any)
}
func sumText(s string) string { hash := sha256.Sum256([]byte(s)); return hex.EncodeToString(hash[:]) }
func writeArgs(path, data string, offset int64, final bool) map[string]any {
	return map[string]any{"root": "workspace", "path": path, "uploadId": uploadID, "offset": offset, "dataBase64": base64.StdEncoding.EncodeToString([]byte(data)), "final": final}
}

func TestLinuxManifestAndPolicyRevision(t *testing.T) {
	h, _, config := hostFixture(t, true)
	first := h.Manifest()
	if first.Kind != "linux" || len(first.Capabilities) != 11 {
		t.Fatalf("unexpected default manifest: %+v", first)
	}
	for _, f := range first.Functions {
		if len(f.Description) > 240 {
			t.Fatalf("description too long: %s", f.Name)
		}
		if f.Name == "system.run" || strings.HasPrefix(f.Name, "service.") {
			t.Fatalf("unconfigured function advertised: %s", f.Name)
		}
	}
	p := h.Policy
	p.Commands["uptime"] = HostCommand{Argv: []string{"/bin/echo", "hello"}, TimeoutSeconds: 30}
	p.Services["worker"] = HostService{"worker.service", []string{"restart"}}
	if e := atomic(filepath.Join(h.State, "policy.json"), p); e != nil {
		t.Fatal(e)
	}
	next, e := newLinuxHarness(filepath.Join(h.State, "policy.json"), config)
	if e != nil {
		t.Fatal(e)
	}
	defer next.Close()
	m := next.Manifest()
	if len(m.Capabilities) != 15 || next.Revision == h.Revision {
		t.Fatalf("policy change did not revise manifest: %+v", m)
	}
	b, _ := json.Marshal(m)
	if len(b) > 16384 {
		t.Fatal("manifest exceeds current transport limit")
	}
}
func TestLinuxFileUploadReadReplaceAndAbort(t *testing.T) {
	h, root, _ := hostFixture(t, true)
	data := strings.Repeat("hello Linux\n", 170)
	for offset := 0; offset < len(data); {
		end := min(offset+768, len(data))
		args := writeArgs("artifact.txt", data[offset:end], int64(offset), end == len(data))
		if end == len(data) {
			args["sha256"] = sumText(data)
		}
		result := hostCall(t, h, "file.write", args)
		if result["nextOffset"] != int64(end) {
			t.Fatal(result)
		}
		offset = end
	}
	got, e := os.ReadFile(filepath.Join(root, "artifact.txt"))
	if e != nil || string(got) != data {
		t.Fatalf("upload did not commit exact contents: %v", e)
	}
	stat := hostCall(t, h, "file.stat", map[string]any{"root": "workspace", "path": "artifact.txt"})
	var read strings.Builder
	for offset := int64(0); ; {
		chunk := hostCall(t, h, "file.read", map[string]any{"root": "workspace", "path": "artifact.txt", "offset": offset, "limit": int64(500)})
		decoded, e := base64.StdEncoding.DecodeString(chunk["dataBase64"].(string))
		if e != nil {
			t.Fatal(e)
		}
		read.Write(decoded)
		if chunk["revision"] != stat["revision"] {
			t.Fatal("reads changed the file revision")
		}
		offset = chunk["nextOffset"].(int64)
		if chunk["eof"] == true {
			break
		}
	}
	if read.String() != data {
		t.Fatal("download corrupted")
	}
	args := writeArgs("artifact.txt", "replacement", 0, true)
	args["sha256"] = sumText("replacement")
	if out := h.Execute(Config{}, hostAction("file.write", args), time.Now()); out.Status != "failed" {
		t.Fatal("create-only upload overwrote target")
	}
	hostCall(t, h, "file.upload_abort", map[string]any{"uploadId": uploadID})
	args["replaceRevision"] = "wrong"
	if out := h.Execute(Config{}, hostAction("file.write", args), time.Now()); out.Status != "failed" {
		t.Fatal("revision mismatch accepted")
	}
	hostCall(t, h, "file.upload_abort", map[string]any{"uploadId": uploadID})
	args["replaceRevision"] = stat["revision"]
	hostCall(t, h, "file.write", args)
	got, e = os.ReadFile(filepath.Join(root, "artifact.txt"))
	if e != nil || string(got) != "replacement" {
		t.Fatal("replacement failed")
	}
	hostCall(t, h, "file.remove", map[string]any{"root": "workspace", "path": "artifact.txt"})
	hostCall(t, h, "file.mkdir", map[string]any{"root": "workspace", "path": "folder"})
	hostCall(t, h, "file.remove", map[string]any{"root": "workspace", "path": "folder"})
}
func TestLinuxFilesDenyEscapeSecretsSpecialFilesAndReadonly(t *testing.T) {
	h, root, config := hostFixture(t, true)
	os.WriteFile(config, []byte("private fixture credential"), 0600)
	if e := os.Symlink(config, filepath.Join(root, "secret-link")); e != nil {
		t.Fatal(e)
	}
	if e := os.Link(config, filepath.Join(root, "secret-hardlink")); e != nil {
		t.Fatal(e)
	}
	if e := syscall.Mkfifo(filepath.Join(root, "pipe"), 0600); e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{"../private/device.json", config, "secret-link", "secret-hardlink", "pipe"} {
		out := h.Execute(Config{}, hostAction("file.read", map[string]any{"root": "workspace", "path": path, "offset": int64(0)}), time.Now())
		if out.Status != "failed" {
			t.Fatalf("unsafe file accepted: %s", path)
		}
	}
	p := h.Policy
	p.Roots["secrets"] = HostRoot{h.State, false}
	if e := atomic(filepath.Join(h.State, "policy.json"), p); e != nil {
		t.Fatal(e)
	}
	if next, e := newLinuxHarness(filepath.Join(h.State, "policy.json"), config); e == nil {
		next.Close()
		t.Fatal("private state accepted as a root")
	}
	readonly, _, _ := hostFixture(t, false)
	if out := readonly.Execute(Config{}, hostAction("file.mkdir", map[string]any{"root": "workspace", "path": "no"}), time.Now()); out.Status != "failed" {
		t.Fatal("read-only policy accepted a write")
	}
}
func TestLinuxUploadIntegrityOrderingExpiryAndLimits(t *testing.T) {
	h, root, _ := hostFixture(t, true)
	args := writeArgs("test", "abc", 1, false)
	if out := h.Execute(Config{}, hostAction("file.write", args), time.Now()); out.Status != "failed" {
		t.Fatal("nonzero initial offset accepted")
	}
	args["offset"] = int64(0)
	hostCall(t, h, "file.write", args)
	if out := h.Execute(Config{}, hostAction("file.write", args), time.Now()); out.Status != "failed" {
		t.Fatal("duplicate chunk advanced the upload")
	}
	args = writeArgs("test", "", 3, true)
	args["sha256"] = sumText("other")
	if out := h.Execute(Config{}, hostAction("file.write", args), time.Now()); out.Status != "failed" {
		t.Fatal("corrupt digest accepted")
	}
	if _, e := os.Stat(filepath.Join(root, "test")); !os.IsNotExist(e) {
		t.Fatal("bad hash published a file")
	}
	meta, part, _ := h.uploadPaths(uploadID)
	var u Upload
	if e := privateRead(meta, &u); e != nil {
		t.Fatal(e)
	}
	u.CreatedAt = time.Now().Add(-2 * time.Hour).UnixMilli()
	atomic(meta, u)
	count, size, e := h.cleanupUploads()
	if e != nil || count != 0 || size != 0 {
		t.Fatalf("expiry cleanup failed: %d %d %v", count, size, e)
	}
	if _, e := os.Stat(part); !os.IsNotExist(e) {
		t.Fatal("expired staged data remained")
	}
	args = writeArgs("expired", "data", 0, false)
	cmd := hostAction("file.write", args)
	cmd.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	if out := h.Execute(Config{}, cmd, time.Now()); out.Status != "failed" {
		t.Fatal("expired command executed")
	}
	args = writeArgs("oversized", strings.Repeat("a", 6145), 0, false)
	if out := h.Execute(Config{}, hostAction("file.write", args), time.Now()); out.Status != "failed" {
		t.Fatal("oversized chunk accepted")
	}
}
func TestLinuxNamedCommandsBoundOutputAndDeadline(t *testing.T) {
	h, _, _ := hostFixture(t, true)
	t.Setenv("OPENLAUNCH_SDK_TOKEN", "fixture-secret-not-for-child")
	h.Policy.Commands["diagnostic"] = HostCommand{Argv: []string{"/bin/sh", "-c", "printf '%s' \"${OPENLAUNCH_SDK_TOKEN-unset}\"; i=0; while [ $i -lt 3000 ]; do printf x; i=$((i+1)); done"}, TimeoutSeconds: 2}
	result := hostCall(t, h, "system.run", map[string]any{"command": "diagnostic"})
	if !strings.HasPrefix(result["stdout"].(string), "unset") || result["truncated"] != true || result["stdoutBytes"].(int64) < 3000 {
		t.Fatalf("output/env isolation failed: %+v", result)
	}
	h.Policy.Commands["wait"] = HostCommand{Argv: []string{"/bin/sh", "-c", "sleep 10 & wait"}, TimeoutSeconds: 10}
	cmd := hostAction("system.run", map[string]any{"command": "wait"})
	cmd.ExpiresAt = time.Now().Add(150 * time.Millisecond).UnixMilli()
	start := time.Now()
	out := h.Execute(Config{}, cmd, start)
	if out.Status != "succeeded" || out.Result.(map[string]any)["timedOut"] != true || time.Since(start) > 2*time.Second {
		t.Fatalf("deadline not enforced: %+v", out)
	}
	cmd = hostAction("system.run", map[string]any{"command": "unknown"})
	if out := h.Execute(Config{}, cmd, time.Now()); out.Status != "failed" {
		t.Fatal("unknown command accepted")
	}
	cmd = hostAction("system.run", map[string]any{"command": "diagnostic", "args": "extra"})
	if out := h.Execute(Config{}, cmd, time.Now()); out.Status != "failed" {
		t.Fatal("agent-supplied arguments accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h.Context = ctx
	if out := h.Execute(Config{}, hostAction("system.run", map[string]any{"command": "wait"}), time.Now()); out.Status != "failed" {
		t.Fatal("interrupted runtime accepted new work")
	}
}
func TestLinuxJournalDeduplicatesRealFileActionAndSingleRuntime(t *testing.T) {
	h, _, config := hostFixture(t, true)
	journal := map[string]JournalEntry{}
	calls := 0
	run := func(c Config, cmd Command, start time.Time) Outcome { calls++; return h.Execute(c, cmd, start) }
	cmd := hostAction("file.mkdir", map[string]any{"root": "workspace", "path": "once"})
	for i := 0; i < 2; i++ {
		if e := processCommand(Config{}, cmd, time.Now(), journal, config+".journal", run); e != nil {
			t.Fatal(e)
		}
	}
	if calls != 1 || journal[cmd.ID].Outcome.Status != "succeeded" {
		t.Fatal("duplicate file action executed")
	}
	lock, e := acquireHostLock(h.State)
	if e != nil {
		t.Fatal(e)
	}
	defer lock.Close()
	if other, e := acquireHostLock(h.State); e == nil {
		other.Close()
		t.Fatal("second runtime acquired lock")
	}
}
func TestLinuxBoundedDirectoryAndNetworkResults(t *testing.T) {
	h, root, _ := hostFixture(t, true)
	for i := 0; i < 18; i++ {
		name := strings.Repeat("a", 230) + string(rune('A'+i))
		if e := os.WriteFile(filepath.Join(root, name), nil, 0600); e != nil {
			t.Fatal(e)
		}
	}
	seen := 0
	offset := int64(0)
	for i := 0; i < 5; i++ {
		result := hostCall(t, h, "file.list", map[string]any{"root": "workspace", "path": ".", "offset": offset})
		seen += len(result["entries"].([]any))
		offset = result["nextOffset"].(int64)
		b, _ := json.Marshal(result)
		if len(b) > 4096 {
			t.Fatal("unbounded directory result")
		}
		if result["eof"] == true {
			break
		}
	}
	if seen != 18 {
		t.Fatalf("pagination lost entries: %d", seen)
	}
	hostCall(t, h, "network.interfaces", map[string]any{})
}
