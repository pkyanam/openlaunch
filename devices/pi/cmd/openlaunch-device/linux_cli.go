package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func checkLinuxConfig(path string) error {
	st, e := os.Lstat(path)
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 16384 {
		return errors.New("saved device configuration must be a private regular file, at most 16 KiB")
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	var c Config
	if json.Unmarshal(b, &c) != nil || c.Profile != "linux" || c.Simulate || c.Token == "" || !eventHex.MatchString(c.Workspace) || !eventDeviceID.MatchString(c.DeviceID) || validateURL(c.URL) != nil {
		return errors.New("invalid saved Linux device configuration; identity was preserved")
	}
	h, e := newLinuxHarness(c.Policy, path)
	if e != nil {
		return e
	}
	defer h.Close()
	_, _, e = loadJournal(path + ".journal")
	return e
}

func acquireHostLock(state string) (*os.File, error) {
	f, e := os.OpenFile(filepath.Join(state, "runtime.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0600)
	if e != nil {
		return nil, e
	}
	st, e := f.Stat()
	if e != nil || !ordinary(st) || st.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, errors.New("invalid private runtime lock")
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("another openlaunch host runtime is already running")
	}
	return f, nil
}
func hostCLI(args []string, config string) bool {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return false
	}
	if args[0] == "start" {
		os.Args = append([]string{os.Args[0]}, args[1:]...)
		return false
	}
	policy := filepath.Join(filepath.Dir(config), "policy.json")
	if args[0] == "help" {
		fmt.Println("openlaunch-host start | policy | manifest | allow-dir | allow-command | allow-service | remove | service")
		fmt.Println("openlaunch-host allow-dir projects /absolute/path [--read-only]")
		fmt.Println("openlaunch-host allow-command uptime /usr/bin/uptime")
		fmt.Println("openlaunch-host allow-service worker worker.service [start stop restart]")
		fmt.Println("openlaunch-host remove root|command|service NAME")
		fmt.Println("openlaunch-host service install|start|stop|restart|status|logs|uninstall")
		return true
	}
	if args[0] == "service" {
		if len(args) != 2 {
			fatal(errors.New("use: openlaunch-host service install|start|stop|restart|status|logs|uninstall"))
		}
		if e := hostServiceCLI(args[1], config); e != nil {
			fatal(e)
		}
		return true
	}
	h, e := newLinuxHarness(policy, config)
	if e != nil {
		fatal(e)
	}
	defer h.Close()
	if args[0] == "policy" || args[0] == "manifest" {
		var value any = h.Policy
		if args[0] == "manifest" {
			value = h.Manifest()
		}
		b, _ := json.MarshalIndent(value, "", "  ")
		fmt.Println(string(b))
		return true
	}
	p := h.Policy
	switch args[0] {
	case "allow-dir":
		if len(args) < 3 || len(args) > 4 || (len(args) == 4 && args[3] != "--read-only") {
			fatal(errors.New("use: openlaunch-host allow-dir NAME /absolute/path [--read-only]"))
		}
		if p.Roots == nil {
			p.Roots = map[string]HostRoot{}
		}
		p.Roots[args[1]] = HostRoot{args[2], len(args) == 3}
	case "allow-command":
		if len(args) < 3 {
			fatal(errors.New("use: openlaunch-host allow-command NAME /absolute/program [fixed arguments]"))
		}
		if p.Commands == nil {
			p.Commands = map[string]HostCommand{}
		}
		p.Commands[args[1]] = HostCommand{Argv: args[2:], TimeoutSeconds: 30}
	case "allow-service":
		if len(args) < 3 || len(args) > 6 {
			fatal(errors.New("use: openlaunch-host allow-service NAME name.service [start stop restart]"))
		}
		if args[2] == "openlaunch-host.service" {
			fatal(errors.New("the agent cannot manage its own harness service"))
		}
		if p.Services == nil {
			p.Services = map[string]HostService{}
		}
		p.Services[args[1]] = HostService{args[2], args[3:]}
	case "remove":
		if len(args) != 3 {
			fatal(errors.New("use: openlaunch-host remove root|command|service NAME"))
		}
		switch args[1] {
		case "root":
			delete(p.Roots, args[2])
		case "command":
			delete(p.Commands, args[2])
		case "service":
			delete(p.Services, args[2])
		default:
			fatal(errors.New("choose root, command or service"))
		}
	default:
		fatal(errors.New("unknown host command; run openlaunch-host help"))
	}
	// Validate candidate configuration before replacing the working owner policy.
	candidate := filepath.Join(h.State, "policy-candidate.json")
	if e = atomic(candidate, p); e != nil {
		fatal(e)
	}
	defer os.Remove(candidate)
	check, e := newLinuxHarness(candidate, config)
	if e != nil {
		fatal(e)
	}
	check.Close()
	if e = os.Rename(candidate, policy); e != nil {
		fatal(e)
	}
	dir, e := os.Open(h.State)
	if e != nil {
		fatal(e)
	}
	e = dir.Sync()
	dir.Close()
	if e != nil {
		fatal(e)
	}
	fmt.Println("Local policy saved. Restart the harness, then reapprove its function grants in the console.")
	return true
}
func hostServiceCLI(action, config string) error {
	if os.Geteuid() == 0 {
		return errors.New("install the service as an unprivileged user")
	}
	program, e := exec.LookPath("systemctl")
	if e != nil {
		return errors.New("systemd user services are unavailable; run openlaunch-host start")
	}
	home, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	unitDir := filepath.Join(home, ".config", "systemd", "user")
	unitPath := filepath.Join(unitDir, "openlaunch-host.service")
	run := func(args ...string) error {
		cmd := exec.Command(program, append([]string{"--user"}, args...)...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	switch action {
	case "install":
		if _, e = os.Lstat(config); e != nil {
			return errors.New("pair this host before installing its service")
		}
		if _, e = os.Lstat(unitPath); e == nil {
			return errors.New("service already exists; use openlaunch-host service start or uninstall")
		}
		if e = os.MkdirAll(unitDir, 0700); e != nil {
			return e
		}
		executable, e := os.Executable()
		if e != nil {
			return e
		}
		quote := func(s string) string {
			return strconv.Quote(strings.ReplaceAll(strings.ReplaceAll(s, "%", "%%"), "$", "$$"))
		}
		unit := "[Unit]\nDescription=openlaunch Linux host\nAfter=network-online.target\n\n[Service]\nExecStart=" + quote(executable) + " --config " + quote(config) + "\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=true\nUMask=0077\nKillMode=control-group\nTimeoutStopSec=5\n\n[Install]\nWantedBy=default.target\n"
		f, e := os.OpenFile(unitPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		_, e = f.WriteString(unit)
		if e == nil {
			e = f.Sync()
		}
		ce := f.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return e
		}
		if e = run("daemon-reload"); e != nil {
			return e
		}
		if e = run("enable", "--now", "openlaunch-host.service"); e != nil {
			return e
		}
		fmt.Println("User service installed. It starts with your user session. For boot without login, the owner must enable user lingering.")
		return nil
	case "uninstall":
		if e = run("disable", "--now", "openlaunch-host.service"); e != nil {
			return e
		}
		if e = os.Remove(unitPath); e != nil {
			return e
		}
		return run("daemon-reload")
	case "start", "stop", "restart", "status":
		return run(action, "openlaunch-host.service")
	case "logs":
		cmd := exec.Command("journalctl", "--user", "--no-pager", "-u", "openlaunch-host.service", "-n", "30")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	default:
		return errors.New("unknown service command")
	}
}
