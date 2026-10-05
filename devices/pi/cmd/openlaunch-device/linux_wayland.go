package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"
)

// A small client for the core registry and wlr virtual pointer protocols.
// Uses only the owner's configured local Unix socket, never a remote endpoint.
type waylandGlobal struct{ name, version uint32 }
type waylandClient struct {
	conn       net.Conn
	globals    map[string]waylandGlobal
	next       uint32
	output     uint32
	outputName string
	stop       func() bool
}

func wlWords(words ...uint32) []byte {
	b := make([]byte, len(words)*4)
	for i, v := range words {
		binary.NativeEndian.PutUint32(b[i*4:], v)
	}
	return b
}
func wlString(s string) []byte {
	n := len(s) + 1
	b := make([]byte, 4+(n+3)/4*4)
	binary.NativeEndian.PutUint32(b, uint32(n))
	copy(b[4:], s)
	return b
}
func readWLString(b []byte) (string, int, error) {
	if len(b) < 4 {
		return "", 0, errors.New("invalid Wayland string")
	}
	n := int(binary.NativeEndian.Uint32(b))
	padded := (n + 3) / 4 * 4
	if n < 1 || n > 512 || len(b) < 4+padded || b[4+n-1] != 0 {
		return "", 0, errors.New("invalid Wayland string")
	}
	return string(b[4 : 4+n-1]), 4 + padded, nil
}
func (w *waylandClient) send(id, opcode uint32, payload []byte) error {
	b := append(wlWords(id, uint32(len(payload)+8)<<16|opcode), payload...)
	for len(b) > 0 {
		n, e := w.conn.Write(b)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
func (w *waylandClient) sync() error {
	callback := w.next
	w.next++
	if e := w.send(1, 0, wlWords(callback)); e != nil {
		return e
	}
	for i := 0; i < 1024; i++ {
		var header [8]byte
		if _, e := io.ReadFull(w.conn, header[:]); e != nil {
			return e
		}
		id := binary.NativeEndian.Uint32(header[:4])
		word := binary.NativeEndian.Uint32(header[4:])
		size := int(word >> 16)
		opcode := word & 65535
		if size < 8 || size > 65532 || size%4 != 0 {
			return errors.New("invalid Wayland message size")
		}
		body := make([]byte, size-8)
		if _, e := io.ReadFull(w.conn, body); e != nil {
			return e
		}
		if id == 1 && opcode == 0 {
			return errors.New("desktop compositor rejected the request")
		}
		if id == callback && opcode == 0 {
			if len(body) != 4 {
				return errors.New("invalid Wayland callback")
			}
			return nil
		}
		if id == 2 && opcode == 0 {
			if len(body) < 12 {
				return errors.New("invalid Wayland registry")
			}
			name := binary.NativeEndian.Uint32(body)
			iface, n, e := readWLString(body[4:])
			if e != nil || len(body) != n+8 {
				return errors.New("invalid Wayland global")
			}
			if len(w.globals) >= 256 {
				return errors.New("too many desktop globals")
			}
			if _, exists := w.globals[iface]; !exists {
				w.globals[iface] = waylandGlobal{name, binary.NativeEndian.Uint32(body[4+n:])}
			}
		}
		if id == w.output && opcode == 4 {
			name, _, e := readWLString(body)
			if e != nil {
				return e
			}
			w.outputName = name
		}
	}
	return errors.New("desktop compositor response limit exceeded")
}
func (w *waylandClient) bind(iface string, version uint32) (uint32, error) {
	g, ok := w.globals[iface]
	if !ok || g.version < version {
		return 0, fmt.Errorf("desktop lacks %s", iface)
	}
	id := w.next
	w.next++
	p := append(wlWords(g.name), wlString(iface)...)
	p = append(p, wlWords(version, id)...)
	return id, w.send(2, 0, p)
}
func (h *LinuxHarness) connectWayland(action Command) (*waylandClient, error) {
	d := h.Policy.Control.Desktop
	path := filepath.Join(fmt.Sprintf("/run/user/%d", os.Getuid()), d.Environment["WAYLAND_DISPLAY"])
	st, e := os.Lstat(path)
	if e != nil || st.Mode()&os.ModeSocket == 0 {
		return nil, errors.New("configured Wayland desktop is not running; log into the Pi desktop")
	}
	ctx, cancel := context.WithDeadline(h.Context, minTime(time.UnixMilli(action.ExpiresAt), time.Now().Add(5*time.Second)))
	defer cancel()
	conn, e := (&net.Dialer{}).DialContext(ctx, "unix", path)
	if e != nil {
		return nil, errors.New("cannot connect to the local desktop")
	}
	deadline, _ := ctx.Deadline()
	conn.SetDeadline(deadline)
	// Register against the harness context, because the dial context ends here.
	stop := context.AfterFunc(h.Context, func() { conn.Close() })
	w := &waylandClient{conn: conn, globals: map[string]waylandGlobal{}, next: 3, stop: stop}
	if e = w.send(1, 1, wlWords(2)); e == nil {
		e = w.sync()
	}
	if e == nil {
		w.output, e = w.bind("wl_output", 4)
	}
	if e == nil {
		e = w.sync()
	}
	if e == nil && w.outputName == "" {
		e = errors.New("desktop output name is unavailable")
	}
	if e != nil {
		w.Close()
		return nil, e
	}
	return w, nil
}
func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
func (w *waylandClient) Close() {
	if w.stop != nil {
		w.stop()
	}
	w.conn.Close()
}
func (w *waylandClient) pointer(args map[string]any) error {
	manager, e := w.bind("zwlr_virtual_pointer_manager_v1", 2)
	if e != nil {
		return e
	}
	pointer := w.next
	w.next++
	if e = w.send(manager, 2, wlWords(0, w.output, pointer)); e != nil {
		return e
	}
	// Ensure compositor initialization before sending any input.
	if e = w.sync(); e != nil {
		return e
	}
	now := uint32(time.Now().UnixMilli())
	operation := args["operation"].(string)
	if operation == "move" || operation == "click" {
		if e = w.send(pointer, 1, wlWords(now, uint32(intArg(args, "x", 0)), uint32(intArg(args, "y", 0)), 65535, 65535)); e != nil {
			return e
		}
		if e = w.send(pointer, 4, nil); e != nil {
			return e
		}
	}
	if operation == "click" {
		buttons := map[int64]uint32{1: 272, 2: 274, 3: 273}
		button := buttons[intArg(args, "button", 1)]
		for _, state := range []uint32{1, 0} {
			if e = w.send(pointer, 2, wlWords(now, button, state)); e != nil {
				return e
			}
			if e = w.send(pointer, 4, nil); e != nil {
				return e
			}
		}
	}
	if operation == "scroll" {
		steps := int32(intArg(args, "steps", 0))
		if e = w.send(pointer, 5, wlWords(0)); e != nil {
			return e
		}
		if e = w.send(pointer, 7, wlWords(now, 0, uint32(steps*15*256), uint32(steps))); e != nil {
			return e
		}
		if e = w.send(pointer, 4, nil); e != nil {
			return e
		}
	}
	if e = w.sync(); e != nil {
		return e
	}
	if e = w.send(pointer, 8, nil); e != nil {
		return e
	}
	if e = w.send(manager, 1, nil); e != nil {
		return e
	}
	return w.sync()
}
