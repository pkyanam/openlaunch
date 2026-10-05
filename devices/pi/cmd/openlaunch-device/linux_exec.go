package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

func intArg(a map[string]any, k string, fallback int64) int64 {
	v, ok := a[k]
	if !ok {
		return fallback
	}
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	}
	return fallback
}
func validateHostArguments(m Manifest, cmd Command) error {
	if cmd.Capability == "device.health" {
		if len(cmd.Args) != 0 {
			return errors.New("health takes no arguments")
		}
		return nil
	}
	for _, f := range m.Functions {
		if f.Name != cmd.Capability {
			continue
		}
		props := f.InputSchema["properties"].(map[string]any)
		for _, name := range f.InputSchema["required"].([]string) {
			if _, ok := cmd.Args[name]; !ok {
				return errors.New("missing required argument")
			}
		}
		for name, value := range cmd.Args {
			p, ok := props[name].(map[string]any)
			if !ok {
				return errors.New("unexpected argument")
			}
			switch p["type"] {
			case "string":
				s, ok := value.(string)
				if !ok || len([]rune(s)) > p["maxLength"].(int) || strings.ContainsRune(s, 0) {
					return errors.New("invalid string argument")
				}
				if min, ok := p["minLength"].(int); ok && len([]rune(s)) < min {
					return errors.New("empty argument")
				}
				if choices, ok := p["enum"].([]string); ok {
					found := false
					for _, choice := range choices {
						if choice == s {
							found = true
						}
					}
					if !found {
						return errors.New("argument is not locally allowed")
					}
				}
			case "integer":
				var n float64
				switch v := value.(type) {
				case float64:
					n = v
				case int:
					n = float64(v)
				case int64:
					n = float64(v)
				default:
					return errors.New("invalid numeric argument")
				}
				if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < float64(p["minimum"].(int64)) || n > float64(p["maximum"].(int64)) {
					return errors.New("numeric argument out of range")
				}
			case "boolean":
				if _, ok := value.(bool); !ok {
					return errors.New("invalid boolean argument")
				}
			}
		}
		return nil
	}
	return errors.New("function is not enabled in the local policy")
}
func cleanText(s string, limit int) string {
	if len(s) > limit {
		s = s[:limit]
	}
	s = strings.ToValidUTF8(s, "�")
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return '�'
		}
		return r
	}, s)
	if len(s) > limit {
		s = strings.ToValidUTF8(s[:limit], "")
	}
	return s
}
func (h *LinuxHarness) Execute(c Config, cmd Command, started time.Time) Outcome {
	if time.Now().UnixMilli() >= cmd.ExpiresAt || h.Context.Err() != nil {
		return Outcome{"failed", map[string]any{"error": "expired_before_execution"}}
	}
	if e := validateHostArguments(h.Manifest(), cmd); e != nil {
		return Outcome{"failed", map[string]any{"error": "local_policy_denied", "message": e.Error()}}
	}
	result, e := h.perform(cmd, started)
	if e != nil {
		return Outcome{"failed", map[string]any{"error": "host_operation_failed", "message": cleanText(e.Error(), 256)}}
	}
	limit := 4096
	if cmd.Capability == "desktop.screenshot" {
		limit = 48 * 1024
	}
	b, e := json.Marshal(result)
	if e != nil || len(b) > limit {
		return Outcome{"failed", map[string]any{"error": "result_limit_exceeded"}}
	}
	return Outcome{"succeeded", result}
}
func (h *LinuxHarness) perform(cmd Command, started time.Time) (any, error) {
	switch {
	case cmd.Capability == "device.health" || cmd.Capability == "system.info":
		return hostSystemInfo(started), nil
	case cmd.Capability == "network.interfaces":
		interfaces, e := net.Interfaces()
		if e != nil {
			return nil, e
		}
		result := make([]any, 0)
		for _, iface := range interfaces {
			if len(result) >= 12 {
				break
			}
			addresses, e := iface.Addrs()
			if e != nil {
				continue
			}
			list := []string{}
			for _, a := range addresses {
				if len(list) >= 4 {
					break
				}
				list = append(list, a.String())
			}
			entry := map[string]any{"name": iface.Name, "mtu": iface.MTU, "flags": iface.Flags.String(), "addresses": list}
			probe := append(append([]any{}, result...), entry)
			b, _ := json.Marshal(probe)
			if len(b) > 3500 {
				break
			}
			result = append(result, entry)
		}
		return map[string]any{"interfaces": result, "truncated": len(result) < len(interfaces)}, nil
	case cmd.Capability == "process.list":
		return hostProcesses(intArg(cmd.Args, "afterPid", 0))
	case strings.HasPrefix(cmd.Capability, "file."):
		return h.files(cmd)
	case cmd.Capability == "system.exec":
		directory, _ := cmd.Args["directory"].(string)
		if directory != "" && !filepath.IsAbs(directory) {
			return nil, errors.New("directory must be absolute")
		}
		command, _ := cmd.Args["command"].(string)
		return h.runProgram(cmd, []string{"/bin/sh", "-c", command}, directory, time.Duration(intArg(cmd.Args, "timeoutSeconds", 30))*time.Second)
	case strings.HasPrefix(cmd.Capability, "desktop."):
		return h.desktop(cmd)
	case cmd.Capability == "system.run":
		name, _ := cmd.Args["command"].(string)
		spec := h.Policy.Commands[name]
		seconds := min(intArg(cmd.Args, "timeoutSeconds", int64(spec.TimeoutSeconds)), int64(spec.TimeoutSeconds))
		return h.runProgram(cmd, spec.Argv, spec.Directory, time.Duration(seconds)*time.Second)
	case strings.HasPrefix(cmd.Capability, "service."):
		name, _ := cmd.Args["service"].(string)
		svc := h.Policy.Services[name]
		if cmd.Capability == "service.logs" {
			program, e := hostTool("journalctl")
			if e != nil {
				return nil, errors.New("journalctl is unavailable")
			}
			return h.runProgram(cmd, []string{program, "--user", "--no-pager", "-u", svc.Unit, "-n", strconv.FormatInt(intArg(cmd.Args, "lines", 20), 10), "-o", "short-iso"}, "", 10*time.Second)
		}
		if cmd.Capability == "service.control" {
			action, _ := cmd.Args["action"].(string)
			allowed := false
			for _, a := range svc.Actions {
				if a == action {
					allowed = true
				}
			}
			if !allowed {
				return nil, errors.New("service action denied by local policy")
			}
		}
		program, e := hostTool("systemctl")
		if e != nil {
			return nil, errors.New("systemctl is unavailable")
		}
		if cmd.Capability == "service.status" {
			return h.runProgram(cmd, []string{program, "--user", "--no-pager", "show", svc.Unit, "--property=Id,LoadState,ActiveState,SubState,MainPID,Result"}, "", 10*time.Second)
		}
		action, _ := cmd.Args["action"].(string)
		allowed := false
		for _, a := range svc.Actions {
			if a == action {
				allowed = true
			}
		}
		if !allowed {
			return nil, errors.New("service action denied by local policy")
		}
		return h.runProgram(cmd, []string{program, "--user", "--no-pager", action, "--", svc.Unit}, "", 20*time.Second)
	}
	return nil, errors.New("unsupported host function")
}

func hostTool(name string) (string, error) {
	for _, directory := range []string{"/usr/bin", "/bin"} {
		path := filepath.Join(directory, name)
		info, err := os.Stat(path)
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return path, nil
		}
	}
	return "", errors.New("host tool is unavailable")
}

type limitedOutput struct {
	sync.Mutex
	data  []byte
	tail  []byte
	total int64
}

func (w *limitedOutput) Write(p []byte) (int, error) {
	w.Lock()
	defer w.Unlock()
	lenOriginal := len(p)
	w.total += int64(len(p))
	space := 512 - len(w.data)
	if space > 0 {
		n := min(space, len(p))
		w.data = append(w.data, p[:n]...)
		p = p[n:]
	}
	if len(p) >= 256 {
		w.tail = append(w.tail[:0], p[len(p)-256:]...)
	} else if len(p) > 0 {
		w.tail = append(w.tail, p...)
		if len(w.tail) > 256 {
			w.tail = append(w.tail[:0], w.tail[len(w.tail)-256:]...)
		}
	}
	// io.Writer must acknowledge all input, including bytes deliberately dropped.
	return lenOriginal, nil
}
func (w *limitedOutput) snapshot() (head, tail string, truncated bool) {
	w.Lock()
	defer w.Unlock()
	truncated = w.total > int64(len(w.data)+len(w.tail))
	if !truncated {
		return cleanText(string(append(append([]byte{}, w.data...), w.tail...)), 768), "", false
	}
	return cleanText(string(w.data), 512), cleanText(string(w.tail), 256), true
}
func (h *LinuxHarness) runProgram(action Command, argv []string, directory string, timeout time.Duration) (any, error) {
	return h.runProgramInput(action, argv, directory, timeout, "")
}
func (h *LinuxHarness) runProgramInput(action Command, argv []string, directory string, timeout time.Duration, input string) (any, error) {
	remaining := time.Until(time.UnixMilli(action.ExpiresAt))
	if remaining <= 0 {
		return nil, errors.New("expired before command start")
	}
	// Leave some of the action TTL for persisting and uploading the result.
	timeout = min(timeout, remaining-min(2*time.Second, remaining/5))
	ctx, cancel := context.WithTimeout(h.Context, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = directory
	cmd.Env = h.childEnvironment()
	cmd.Stdin = strings.NewReader(input)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		e := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if e == syscall.ESRCH {
			return os.ErrProcessDone
		}
		return e
	}
	cmd.WaitDelay = time.Second
	stdout, stderr := &limitedOutput{}, &limitedOutput{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	start := time.Now()
	e := cmd.Run()
	// Clean up children that inherited pipes or were left running by the parent.
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	code := 0
	if e != nil {
		code = -1
		var exit *exec.ExitError
		if errors.As(e, &exit) {
			code = exit.ExitCode()
		} else if ctx.Err() == nil && !errors.Is(e, exec.ErrWaitDelay) {
			return nil, errors.New("configured program could not execute")
		}
	}
	outHead, outTail, outTruncated := stdout.snapshot()
	errHead, errTail, errTruncated := stderr.snapshot()
	report := map[string]any{"exitCode": code, "stdout": outHead, "stderr": errHead, "stdoutBytes": stdout.total, "stderrBytes": stderr.total, "truncated": outTruncated || errTruncated, "timedOut": ctx.Err() == context.DeadlineExceeded, "interrupted": ctx.Err() == context.Canceled, "durationMs": time.Since(start).Milliseconds()}
	if outTruncated {
		report["stdoutTail"] = outTail
	}
	if errTruncated {
		report["stderrTail"] = errTail
	}
	// JSON escaping can expand quotes, HTML characters and control bytes.
	// Keep the complete receipt inside the same 4096-byte transport budget.
	for {
		encoded, _ := json.Marshal(report)
		if len(encoded) <= 4096 {
			break
		}
		report["truncated"] = true
		for _, key := range []string{"stdout", "stderr", "stdoutTail", "stderrTail"} {
			value, _ := report[key].(string)
			if strings.HasSuffix(key, "Tail") {
				value = value[len(value)/2:]
			} else {
				value = value[:len(value)/2]
			}
			if _, present := report[key]; present {
				report[key] = cleanText(value, len(value))
			}
		}
	}
	return report, nil
}
func smallRead(path string) string {
	f, e := os.Open(path)
	if e != nil {
		return ""
	}
	defer f.Close()
	b := make([]byte, 16384)
	n, _ := f.Read(b)
	return string(b[:n])
}
func hostSystemInfo(started time.Time) map[string]any {
	name, _ := os.Hostname()
	info := map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "hostname": cleanText(name, 64), "cpuCount": runtime.NumCPU(), "adapterUptimeSeconds": int64(time.Since(started).Seconds()), "simulated": false}
	for _, line := range strings.Split(smallRead("/etc/os-release"), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			info["distribution"] = cleanText(strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\""), 128)
		}
	}
	info["kernel"] = strings.TrimSpace(smallRead("/proc/sys/kernel/osrelease"))
	if fields := strings.Fields(smallRead("/proc/uptime")); len(fields) > 0 {
		uptime, _ := strconv.ParseFloat(fields[0], 64)
		info["systemUptimeSeconds"] = uptime
	}
	if fields := strings.Fields(smallRead("/proc/loadavg")); len(fields) >= 3 {
		load := []float64{}
		for _, s := range fields[:3] {
			v, _ := strconv.ParseFloat(s, 64)
			load = append(load, v)
		}
		info["loadAverage"] = load
	}
	mem := map[string]int64{}
	for _, line := range strings.Split(smallRead("/proc/meminfo"), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && (fields[0] == "MemTotal:" || fields[0] == "MemAvailable:") {
			v, _ := strconv.ParseInt(fields[1], 10, 64)
			mem[strings.TrimSuffix(fields[0], ":")] = v * 1024
		}
	}
	info["memoryBytes"] = mem
	var disk syscall.Statfs_t
	if syscall.Statfs("/", &disk) == nil {
		info["diskBytes"] = map[string]uint64{"total": uint64(disk.Blocks) * uint64(disk.Bsize), "available": uint64(disk.Bavail) * uint64(disk.Bsize)}
	}
	model := strings.TrimSpace(strings.TrimRight(smallRead("/proc/device-tree/model"), "\x00"))
	if model != "" {
		info["model"] = cleanText(model, 128)
	}
	if raw := strings.TrimSpace(smallRead("/sys/class/thermal/thermal_zone0/temp")); raw != "" {
		v, e := strconv.ParseFloat(raw, 64)
		if e == nil {
			info["temperatureC"] = v / 1000
		}
	}
	return info
}
func hostProcesses(after int64) (any, error) {
	entries, e := os.ReadDir("/proc")
	if e != nil {
		return nil, errors.New("Linux procfs is unavailable")
	}
	pids := map[string]int{}
	for _, entry := range entries {
		pid, e := strconv.Atoi(entry.Name())
		if e == nil && int64(pid) > after {
			pids[fmt.Sprintf("%010d", pid)] = pid
		}
	}
	result := []any{}
	next := after
	for _, key := range sortedNames(pids) {
		pid := pids[key]
		dir := filepath.Join("/proc", strconv.Itoa(pid))
		comm := cleanText(strings.TrimSpace(smallRead(filepath.Join(dir, "comm"))), 64)
		if comm == "" {
			continue
		}
		state := ""
		for _, line := range strings.Split(smallRead(filepath.Join(dir, "status")), "\n") {
			if strings.HasPrefix(line, "State:") {
				state = cleanText(strings.TrimSpace(strings.TrimPrefix(line, "State:")), 32)
			}
		}
		result = append(result, map[string]any{"pid": pid, "name": comm, "state": state})
		next = int64(pid)
		if len(result) >= 12 {
			break
		}
	}
	return map[string]any{"processes": result, "afterPid": next, "eof": len(result) < 12}, nil
}
