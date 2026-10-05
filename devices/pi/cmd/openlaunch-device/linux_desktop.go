package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type boundedCapture struct {
	sync.Mutex
	data     []byte
	limit    int
	overflow bool
}

func (b *boundedCapture) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	space := b.limit - len(b.data)
	if len(p) > space {
		b.overflow = true
	}
	b.data = append(b.data, p[:min(space, len(p))]...)
	return len(p), nil
}
func (h *LinuxHarness) checkDesktop() error {
	action := Command{ExpiresAt: time.Now().Add(5 * time.Second).UnixMilli()}
	d := h.Policy.Control.Desktop
	for _, tool := range desktopTools(d.Backend) {
		if _, e := hostTool(tool); e != nil {
			return fmt.Errorf("desktop helper %s is unavailable", tool)
		}
	}
	if d.Backend == "wayland" {
		w, e := h.connectWayland(action)
		if e != nil {
			return e
		}
		defer w.Close()
		for _, iface := range []string{"zwlr_screencopy_manager_v1", "zwp_virtual_keyboard_manager_v1", "zwlr_virtual_pointer_manager_v1"} {
			g, ok := w.globals[iface]
			if !ok || g.version == 0 || iface == "zwlr_virtual_pointer_manager_v1" && g.version < 2 {
				return fmt.Errorf("desktop lacks %s; use Raspberry Pi OS labwc or a supported X11 session", iface)
			}
		}
		return nil
	}
	_, _, e := h.x11Size(action)
	return e
}
func (h *LinuxHarness) desktop(cmd Command) (any, error) {
	if h.Policy.Control == nil || h.Policy.Control.Desktop == nil {
		return nil, errors.New("desktop control is disabled")
	}
	d := h.Policy.Control.Desktop
	if cmd.Capability == "desktop.status" {
		e := h.checkDesktop()
		result := map[string]any{"backend": d.Backend, "available": e == nil, "simulated": false}
		if e != nil {
			result["message"] = cleanText(e.Error(), 256)
		}
		return result, nil
	}
	if e := h.checkDesktop(); e != nil {
		return nil, e
	}
	switch cmd.Capability {
	case "desktop.open":
		return h.openBrowser(cmd)
	case "desktop.screenshot":
		return h.captureDesktop(cmd)
	case "desktop.input":
		return h.inputDesktop(cmd)
	}
	return nil, errors.New("unsupported desktop operation")
}
func successfulProgram(result any, e error) (map[string]any, error) {
	if e != nil {
		return nil, e
	}
	r := result.(map[string]any)
	if r["exitCode"] != 0 || r["timedOut"] == true || r["interrupted"] == true {
		return nil, fmt.Errorf("desktop helper failed (exit %v, timedOut %v): %s", r["exitCode"], r["timedOut"], cleanText(r["stderr"].(string), 150))
	}
	return r, nil
}
func (h *LinuxHarness) openBrowser(cmd Command) (any, error) {
	location := "about:blank"
	if value, ok := cmd.Args["url"].(string); ok {
		u, e := url.Parse(value)
		if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(value, "\r\n\t") {
			return nil, errors.New("browser URL must be HTTP(S), without embedded credentials")
		}
		location = u.String()
	}
	browser, e := browserTool()
	if e != nil {
		return nil, e
	}
	runner, e := hostTool("systemd-run")
	if e != nil {
		return nil, e
	}
	env, e := hostTool("env")
	if e != nil {
		return nil, e
	}
	// A transient user service survives the bounded command process group.
	// env -i prevents credentials imported into the systemd manager leaking in.
	// Type=exec verifies execution; it cannot verify visible window creation.
	unit := "openlaunch-browser-" + cmd.ID + ".service"
	argv := h.browserLaunchArgv(runner, env, browser, location, unit)
	if _, e = successfulProgram(h.runProgram(cmd, argv, "", 10*time.Second)); e != nil {
		return nil, e
	}
	return map[string]any{"launchAccepted": true, "unit": unit, "windowVerified": false, "browser": filepath.Base(browser), "url": location, "nextStep": "Check desktop.screenshot to verify the browser window."}, nil
}

func (h *LinuxHarness) browserLaunchArgv(runner, env, browser, location, unit string) []string {
	argv := []string{runner, "--user", "--unit=" + unit, "--collect", "--quiet", "--property=Type=exec", "--expand-environment=no", env, "-i"}
	argv = append(argv, h.childEnvironment()...)
	backend := h.Policy.Control.Desktop.Backend
	if filepath.Base(browser) == "firefox" && backend == "wayland" {
		argv = append(argv, "MOZ_ENABLE_WAYLAND=1", "GDK_BACKEND=wayland")
	}
	argv = append(argv, browser)
	if strings.HasPrefix(filepath.Base(browser), "chromium") {
		argv = append(argv, "--ozone-platform="+backend)
	}
	return append(argv, "--new-window", location)
}
func (h *LinuxHarness) x11Size(cmd Command) (int, int, error) {
	tool, e := hostTool("xdotool")
	if e != nil {
		return 0, 0, e
	}
	r, e := successfulProgram(h.runProgram(cmd, []string{tool, "getdisplaygeometry"}, "", 5*time.Second))
	if e != nil {
		return 0, 0, e
	}
	fields := strings.Fields(r["stdout"].(string))
	if len(fields) != 2 {
		return 0, 0, errors.New("invalid desktop geometry")
	}
	width, _ := strconv.Atoi(fields[0])
	height, _ := strconv.Atoi(fields[1])
	if width < 1 || height < 1 || width > 8192 || height > 8192 {
		return 0, 0, errors.New("desktop geometry exceeds supported bounds")
	}
	return width, height, nil
}
func (h *LinuxHarness) captureDesktop(cmd Command) (any, error) {
	count := 0
	for _, k := range []string{"x", "y", "width", "height"} {
		if _, ok := cmd.Args[k]; ok {
			count++
		}
	}
	if count != 0 && count != 4 {
		return nil, errors.New("crop requires x, y, width and height together")
	}
	temp, e := os.MkdirTemp(h.State, "screen-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(temp)
	path := filepath.Join(temp, "screen.png")
	var argv []string
	if h.Policy.Control.Desktop.Backend == "wayland" {
		w, e := h.connectWayland(cmd)
		if e != nil {
			return nil, e
		}
		name := w.outputName
		w.Close()
		tool, _ := hostTool("grim")
		argv = []string{tool, "-c", "-s", "1", "-t", "png", "-o", name, path}
	} else {
		tool, _ := hostTool("scrot")
		argv = []string{tool, "-p", path}
	}
	if _, e = successfulProgram(h.runProgram(cmd, argv, "", 8*time.Second)); e != nil {
		return nil, e
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Size() > 16<<20 {
		return nil, errors.New("captured image exceeds 16 MiB")
	}
	data, e := io.ReadAll(io.LimitReader(f, 16<<20+1))
	if e != nil || len(data) > 16<<20 {
		return nil, errors.New("capture read limit exceeded")
	}
	config, e := png.DecodeConfig(bytes.NewReader(data))
	if e != nil || config.Width < 1 || config.Height < 1 || config.Width > 8192 || config.Height > 8192 || int64(config.Width)*int64(config.Height) > 32<<20 {
		return nil, errors.New("invalid or oversized screenshot dimensions")
	}
	source, e := png.Decode(bytes.NewReader(data))
	if e != nil {
		return nil, e
	}
	rect := source.Bounds()
	if count == 4 {
		x, y := int(intArg(cmd.Args, "x", 0)), int(intArg(cmd.Args, "y", 0))
		width, height := int(intArg(cmd.Args, "width", 0)), int(intArg(cmd.Args, "height", 0))
		rect = image.Rect(x, y, x+width, y+height)
		if !rect.In(source.Bounds()) {
			return nil, errors.New("crop is outside the captured screen")
		}
	}
	encoded, width, height, e := desktopPreview(source, rect)
	if e != nil {
		return nil, e
	}
	return map[string]any{"mimeType": "image/jpeg", "imageBase64": base64.StdEncoding.EncodeToString(encoded), "width": width, "height": height, "screenWidth": config.Width, "screenHeight": config.Height, "cropX": rect.Min.X, "cropY": rect.Min.Y, "cropWidth": rect.Dx(), "cropHeight": rect.Dy(), "simulated": false}, nil
}
func desktopPreview(source image.Image, rect image.Rectangle) ([]byte, int, int, error) {
	width, height := rect.Dx(), rect.Dy()
	if width > 1280 || height > 1280 {
		scale := min(1280.0/float64(width), 1280.0/float64(height))
		width = max(1, int(float64(width)*scale))
		height = max(1, int(float64(height)*scale))
	}
	for attempt := 0; attempt < 8; attempt++ {
		resized := image.NewRGBA(image.Rect(0, 0, width, height))
		for y := 0; y < height; y++ {
			for x := 0; x < width; x++ {
				resized.Set(x, y, source.At(rect.Min.X+x*rect.Dx()/width, rect.Min.Y+y*rect.Dy()/height))
			}
		}
		for _, quality := range []int{75, 55, 35} {
			var b bytes.Buffer
			if e := jpeg.Encode(&b, resized, &jpeg.Options{Quality: quality}); e != nil {
				return nil, 0, 0, e
			}
			if b.Len() <= 32*1024 {
				return b.Bytes(), width, height, nil
			}
		}
		width = max(1, width*3/4)
		height = max(1, height*3/4)
	}
	return nil, 0, 0, errors.New("could not fit screenshot in the image receipt")
}
func validateDesktopInput(args map[string]any) error {
	op := args["operation"].(string)
	permitted := map[string]bool{"operation": true}
	required := []string{}
	switch op {
	case "move", "click":
		required = []string{"x", "y"}
		permitted["x"] = true
		permitted["y"] = true
		if op == "click" {
			permitted["button"] = true
		}
	case "scroll":
		required = []string{"steps"}
		permitted["steps"] = true
	case "type":
		required = []string{"text"}
		permitted["text"] = true
	case "key":
		required = []string{"key"}
		permitted["key"] = true
	default:
		return errors.New("invalid input operation")
	}
	for k := range args {
		if !permitted[k] {
			return errors.New("argument is not used by this input operation")
		}
	}
	for _, k := range required {
		if _, ok := args[k]; !ok {
			return fmt.Errorf("%s requires %s", op, k)
		}
	}
	return nil
}
func keyboardArgs(chord string, wayland bool) ([]string, error) {
	parts := strings.Split(chord, "+")
	if len(parts) > 5 {
		return nil, errors.New("key chord is too long")
	}
	modifiers := map[string]string{"ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift", "super": "logo", "meta": "logo"}
	keys := []string{}
	seen := map[string]bool{}
	for _, part := range parts[:len(parts)-1] {
		mod, ok := modifiers[strings.ToLower(part)]
		if !ok || seen[mod] {
			return nil, errors.New("unknown or duplicate key modifier")
		}
		seen[mod] = true
		keys = append(keys, mod)
	}
	key := parts[len(parts)-1]
	if !keyName.MatchString(key) {
		return nil, errors.New("invalid key name")
	}
	if !wayland {
		for i, k := range keys {
			if k == "logo" {
				keys[i] = "super"
			}
		}
		return []string{"key", "--clearmodifiers", strings.Join(append(keys, key), "+")}, nil
	}
	argv := []string{}
	for _, mod := range keys {
		argv = append(argv, "-M", mod)
	}
	argv = append(argv, "-P", key, "-p", key)
	for i := len(keys) - 1; i >= 0; i-- {
		argv = append(argv, "-m", keys[i])
	}
	return argv, nil
}
func (h *LinuxHarness) inputDesktop(cmd Command) (any, error) {
	if e := validateDesktopInput(cmd.Args); e != nil {
		return nil, e
	}
	op := cmd.Args["operation"].(string)
	wayland := h.Policy.Control.Desktop.Backend == "wayland"
	if wayland && (op == "move" || op == "click" || op == "scroll") {
		w, e := h.connectWayland(cmd)
		if e != nil {
			return nil, e
		}
		defer w.Close()
		if e = w.pointer(cmd.Args); e != nil {
			return nil, e
		}
	} else {
		name := "xdotool"
		if wayland {
			name = "wtype"
		}
		tool, e := hostTool(name)
		if e != nil {
			return nil, e
		}
		var args []string
		input := ""
		switch op {
		case "type":
			input = cmd.Args["text"].(string)
			if wayland {
				args = []string{"-"}
			} else {
				args = []string{"type", "--clearmodifiers", "--delay", "0", "--file", "-"}
			}
		case "key":
			args, e = keyboardArgs(cmd.Args["key"].(string), wayland)
			if e != nil {
				return nil, e
			}
		case "move", "click":
			width, height, e := h.x11Size(cmd)
			if e != nil {
				return nil, e
			}
			x, y := intArg(cmd.Args, "x", 0)*int64(width-1)/65535, intArg(cmd.Args, "y", 0)*int64(height-1)/65535
			args = []string{"mousemove", fmt.Sprint(x), fmt.Sprint(y)}
			if op == "click" {
				args = append(args, "click", fmt.Sprint(intArg(cmd.Args, "button", 1)))
			}
		case "scroll":
			steps := intArg(cmd.Args, "steps", 0)
			button := 5
			if steps < 0 {
				button = 4
				steps = -steps
			}
			if steps == 0 {
				return map[string]any{"inputSent": false, "operation": op}, nil
			}
			args = []string{"click", "--repeat", fmt.Sprint(steps), "--delay", "0", fmt.Sprint(button)}
		}
		if _, e = successfulProgram(h.runProgramInput(cmd, append([]string{tool}, args...), "", 15*time.Second, input)); e != nil {
			return nil, e
		}
	}
	return map[string]any{"inputSent": true, "operation": op, "effectVerified": false, "nextStep": "Check a new screenshot to observe the effect."}, nil
}
