package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Host policy is owner-controlled local configuration, never an agent argument.
// The cloud grant and this policy must both permit an operation.
type HostRoot struct {
	Path  string `json:"path"`
	Write bool   `json:"write"`
}
type HostCommand struct {
	Argv           []string `json:"argv"`
	Directory      string   `json:"directory,omitempty"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
}
type HostService struct {
	Unit    string   `json:"unit"`
	Actions []string `json:"actions"`
}
type HostPolicy struct {
	Version  int                    `json:"version"`
	Name     string                 `json:"name"`
	Roots    map[string]HostRoot    `json:"roots"`
	Commands map[string]HostCommand `json:"commands"`
	Services map[string]HostService `json:"services"`
	Control  *HostControl           `json:"control,omitempty"`
}
type FunctionDefinition struct {
	Name        string         `json:"name"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Access      string         `json:"access"`
	InputSchema map[string]any `json:"inputSchema"`
}
type LinuxHarness struct {
	Policy   HostPolicy
	Roots    map[string]*os.Root
	State    string
	Revision string
	Context  context.Context
}

var hostAlias = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
var hostUnit = regexp.MustCompile(`^[a-zA-Z0-9_@.:-]{1,128}\.service$`)

func hostConfigPath() string {
	home, e := os.UserHomeDir()
	if e != nil {
		fatal(e)
	}
	return filepath.Join(home, ".config", "openlaunch", "host", "device.json")
}
func privateDirectory(path string) error {
	// Refuse symlink ancestors of the credential / transfer directory.
	abs, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	for p := abs; ; p = filepath.Dir(p) {
		if st, e := os.Lstat(p); e == nil && st.Mode()&os.ModeSymlink != 0 {
			return errors.New("private state directory cannot use symlinks")
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	if e = os.MkdirAll(abs, 0700); e != nil {
		return e
	}
	st, e := os.Stat(abs)
	if e != nil {
		return e
	}
	if !st.IsDir() || st.Mode().Perm()&0077 != 0 {
		return errors.New("state directory must be private (chmod 700)")
	}
	return nil
}
func initLinuxPolicy(path, config string) error {
	if e := privateDirectory(filepath.Dir(config)); e != nil {
		return e
	}
	if _, e := os.Lstat(path); e == nil {
		h, err := newLinuxHarness(path, config)
		if err == nil {
			h.Close()
		}
		e = err
		return e
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	home, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	workspace := filepath.Join(home, ".local", "share", "openlaunch", "workspace")
	if e = os.MkdirAll(workspace, 0700); e != nil {
		return e
	}
	name, _ := os.Hostname()
	if name == "" {
		name = "linux-host"
	}
	if len(name) > 64 {
		name = name[:64]
	}
	p := HostPolicy{1, name, map[string]HostRoot{"workspace": {workspace, true}}, map[string]HostCommand{}, map[string]HostService{}, nil}
	if e = atomic(path, p); e != nil {
		return e
	}
	h, e := newLinuxHarness(path, config)
	if e == nil {
		h.Close()
	}
	return e
}
func newLinuxHarness(policy, config string) (*LinuxHarness, error) {
	state, e := filepath.Abs(filepath.Dir(config))
	if e != nil {
		return nil, e
	}
	if e = privateDirectory(state); e != nil {
		return nil, e
	}
	policyAbs, e := filepath.Abs(policy)
	if e != nil || filepath.Dir(policyAbs) != state {
		return nil, errors.New("policy must live alongside private device credentials")
	}
	st, e := os.Lstat(policyAbs)
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 32768 {
		return nil, errors.New("policy must be a private regular file, at most 32 KiB")
	}
	f, e := os.Open(policyAbs)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	var p HostPolicy
	decoder := json.NewDecoder(io.LimitReader(f, 32769))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&p); e != nil {
		return nil, errors.New("invalid local policy")
	}
	if e = decoder.Decode(new(any)); e != io.EOF {
		return nil, errors.New("invalid trailing policy data")
	}
	if p.Version != 1 || len(p.Name) < 1 || len(p.Name) > 64 || len(p.Roots) < 1 || len(p.Roots) > 16 || len(p.Commands) > 32 || len(p.Services) > 32 {
		return nil, errors.New("invalid policy version, name or entry count")
	}
	h := &LinuxHarness{Policy: p, Roots: map[string]*os.Root{}, State: state, Context: context.Background()}
	ok := false
	defer func() {
		if !ok {
			h.Close()
		}
	}()
	for alias, root := range p.Roots {
		if !hostAlias.MatchString(alias) || !filepath.IsAbs(root.Path) {
			return nil, errors.New("roots need short aliases and absolute paths")
		}
		canonical, e := filepath.EvalSymlinks(root.Path)
		if e != nil {
			return nil, fmt.Errorf("root %s is unavailable", alias)
		}
		// Keep credentials, policy, pending attach and transfer data outside all roots.
		if containsPath(canonical, state) || containsPath(state, canonical) {
			return nil, errors.New("file roots must not contain or live inside private state")
		}
		r, e := os.OpenRoot(canonical)
		if e != nil {
			return nil, e
		}
		h.Roots[alias] = r
	}
	for alias, cmd := range p.Commands {
		if !hostAlias.MatchString(alias) || len(cmd.Argv) < 1 || len(cmd.Argv) > 32 || !filepath.IsAbs(cmd.Argv[0]) || cmd.TimeoutSeconds < 1 || cmd.TimeoutSeconds > 120 {
			return nil, errors.New("commands require fixed absolute argv and a 1–120 second timeout")
		}
		for _, arg := range cmd.Argv {
			if len(arg) > 1024 || strings.ContainsRune(arg, 0) {
				return nil, errors.New("invalid command argument")
			}
		}
		if cmd.Directory != "" && !filepath.IsAbs(cmd.Directory) {
			return nil, errors.New("command directory must be absolute")
		}
		executable, err := os.Stat(cmd.Argv[0])
		if err != nil || !executable.Mode().IsRegular() || executable.Mode().Perm()&0111 == 0 {
			return nil, errors.New("configured command must be an existing executable")
		}
		if cmd.Directory != "" {
			directory, err := os.Stat(cmd.Directory)
			if err != nil || !directory.IsDir() {
				return nil, errors.New("configured command directory is unavailable")
			}
		}
	}
	for alias, svc := range p.Services {
		if !hostAlias.MatchString(alias) || !hostUnit.MatchString(svc.Unit) || svc.Unit == "openlaunch-host.service" || len(svc.Actions) > 3 {
			return nil, errors.New("invalid named user service")
		}
		seen := map[string]bool{}
		for _, action := range svc.Actions {
			if (action != "start" && action != "stop" && action != "restart") || seen[action] {
				return nil, errors.New("invalid service action")
			}
			seen[action] = true
		}
	}
	if e = validateHostControl(p.Control); e != nil {
		return nil, e
	}
	b, _ := json.Marshal(p)
	digest := sha256.Sum256(b)
	h.Revision = hex.EncodeToString(digest[:])[:16]
	manifest, err := json.Marshal(h.Manifest())
	if err != nil || len(manifest) > 14500 {
		return nil, errors.New("policy manifest exceeds the transport limit; use fewer roots, commands or services")
	}
	ok = true
	return h, nil
}
func containsPath(parent, child string) bool {
	rel, e := filepath.Rel(parent, child)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}
func (h *LinuxHarness) Close() {
	for _, root := range h.Roots {
		root.Close()
	}
}
func sortedNames[T any](m map[string]T) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
func textProperty(limit int, choices ...string) map[string]any {
	p := map[string]any{"type": "string", "maxLength": limit, "minLength": 1}
	if len(choices) > 0 {
		p["enum"] = choices
	}
	return p
}
func numberProperty(min, max int64) map[string]any {
	return map[string]any{"type": "integer", "minimum": min, "maximum": max}
}
func (h *LinuxHarness) Manifest() Manifest {
	m := Manifest{Name: h.Policy.Name, Kind: "linux", Capabilities: []string{"device.health"}}
	add := func(name, title, desc, access string, props map[string]any, required ...string) {
		if props == nil {
			props = map[string]any{}
		}
		if required == nil {
			required = []string{}
		}
		m.Capabilities = append(m.Capabilities, name)
		m.Functions = append(m.Functions, FunctionDefinition{name, title, desc + " Local policy " + h.Revision + ".", access, map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}})
	}
	pathProps := func() map[string]any {
		return map[string]any{"root": textProperty(32, sortedNames(h.Policy.Roots)...), "path": textProperty(256)}
	}
	add("file.root_info", "Locate allowed file root", "Return the real absolute path and write policy for one allowed root alias. workspace is separate from the user's Desktop.", "read", map[string]any{"root": textProperty(32, sortedNames(h.Policy.Roots)...)}, "root")
	add("system.info", "Inspect Linux system", "OS, kernel, CPU, memory, disk and adapter information.", "read", nil)
	add("network.interfaces", "Inspect network interfaces", "Interface names, addresses, MTU and link flags. Does not connect to other hosts.", "read", nil)
	add("process.list", "Inspect processes", "Paginated process IDs, names and state; excludes environment and command lines.", "read", map[string]any{"afterPid": numberProperty(0, 1<<31-1)})
	props := pathProps()
	props["offset"] = numberProperty(0, 1<<31-1)
	add("file.list", "List directory", "List up to 12 entries inside an allowed root. Use nextOffset to continue.", "read", props, "root", "path")
	add("file.stat", "Inspect file", "Inspect a regular file or directory inside an allowed root.", "read", pathProps(), "root", "path")
	props = pathProps()
	props["offset"] = numberProperty(0, 1<<40)
	props["limit"] = numberProperty(1, 2048)
	add("file.read", "Read file chunk", "Read at most 2048 bytes as base64, with nextOffset and a revision for detecting changes.", "read", props, "root", "path", "offset")
	writable := map[string]HostRoot{}
	for n, r := range h.Policy.Roots {
		if r.Write {
			writable[n] = r
		}
	}
	if len(writable) > 0 {
		writeProps := func() map[string]any {
			return map[string]any{"root": textProperty(32, sortedNames(writable)...), "path": textProperty(256)}
		}
		add("file.mkdir", "Create directory", "Create a directory inside a writable root. No recursive deletion is available.", "write", writeProps(), "root", "path")
		props = writeProps()
		props["text"] = map[string]any{"type": "string", "maxLength": 8192}
		props["replaceRevision"] = textProperty(64)
		add("file.write_text", "Write text file", "Atomically create a UTF-8 file, up to 8192 bytes. Supply literal text; the device computes SHA-256. Overwrite requires file.stat replaceRevision. Parents must exist.", "write", props, "root", "path", "text")
		add("file.remove", "Remove file or empty directory", "Remove one regular file or empty directory inside a writable root.", "write", writeProps(), "root", "path")
		props = writeProps()
		props["uploadId"] = textProperty(36)
		props["offset"] = numberProperty(0, 2<<20)
		props["dataBase64"] = map[string]any{"type": "string", "maxLength": 8192}
		props["final"] = map[string]any{"type": "boolean"}
		props["sha256"] = textProperty(64)
		props["replaceRevision"] = textProperty(64)
		add("file.write", "Upload file chunk", "Ordered 6144-byte chunks, up to 2 MiB total. Final requires SHA-256. Create-only unless replaceRevision matches file.stat. Uploads expire after 1 hour.", "write", props, "root", "path", "uploadId", "offset", "dataBase64", "final")
		add("file.upload_abort", "Abort staged upload", "Remove one unfinished private upload by its UUID.", "write", map[string]any{"uploadId": textProperty(36)}, "uploadId")
	}
	if len(h.Policy.Commands) > 0 {
		add("system.run", "Run named command", "Run owner-configured fixed argv as the adapter user. Bounded output and timeout; no agent-provided shell or arguments.", "write", map[string]any{"command": textProperty(32, sortedNames(h.Policy.Commands)...), "timeoutSeconds": numberProperty(1, 120)}, "command")
	}
	if len(h.Policy.Services) > 0 {
		props = map[string]any{"service": textProperty(32, sortedNames(h.Policy.Services)...)}
		add("service.status", "Inspect user service", "Inspect one locally allowed systemd user service.", "read", props, "service")
		props = map[string]any{"service": textProperty(32, sortedNames(h.Policy.Services)...), "lines": numberProperty(1, 30)}
		add("service.logs", "Read user service logs", "Read bounded recent journal output for one allowed user service.", "read", props, "service")
		props = map[string]any{"service": textProperty(32, sortedNames(h.Policy.Services)...), "action": textProperty(7, "start", "stop", "restart")}
		add("service.control", "Control user service", "Start, stop or restart a named user service when its local action list permits it.", "write", props, "service", "action")
	}
	h.controlManifest(add)
	return m
}
