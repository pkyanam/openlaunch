package main

import (
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

type wlRequest struct {
	id, opcode uint32
	body       []byte
}

func TestWaylandPointerUsesAbsoluteCoordinatesAndReleasesButtons(t *testing.T) {
	client, server := net.Pipe()
	w := &waylandClient{conn: client, next: 10, output: 9, globals: map[string]waylandGlobal{"zwlr_virtual_pointer_manager_v1": {7, 2}}}
	client.SetDeadline(time.Now().Add(time.Second))
	server.SetDeadline(time.Now().Add(time.Second))
	requests := make(chan []wlRequest, 1)
	go func() {
		defer server.Close()
		all := []wlRequest{}
		for {
			var header [8]byte
			if _, e := io.ReadFull(server, header[:]); e != nil {
				break
			}
			id := binary.NativeEndian.Uint32(header[:])
			word := binary.NativeEndian.Uint32(header[4:])
			size := int(word >> 16)
			if size < 8 || size > 65532 {
				break
			}
			body := make([]byte, size-8)
			if _, e := io.ReadFull(server, body); e != nil {
				break
			}
			all = append(all, wlRequest{id, word & 65535, body})
			if id == 1 && word&65535 == 0 {
				callback := binary.NativeEndian.Uint32(body)
				if _, e := server.Write(append(wlWords(callback, 12<<16), wlWords(123)...)); e != nil {
					break
				}
			}
		}
		requests <- all
	}()
	if e := w.pointer(map[string]any{"operation": "click", "x": 12345, "y": 54321, "button": 3}); e != nil {
		t.Fatal(e)
	}
	w.Close()
	all := <-requests
	motion := false
	states := []uint32{}
	destroyed := false
	for _, r := range all {
		if r.id == 11 && r.opcode == 1 {
			words := []uint32{}
			for offset := 0; offset < len(r.body); offset += 4 {
				words = append(words, binary.NativeEndian.Uint32(r.body[offset:]))
			}
			if len(words) != 5 || words[1] != 12345 || words[2] != 54321 || words[3] != 65535 || words[4] != 65535 {
				t.Fatal("wrong absolute coordinate extent", words)
			}
			motion = true
		}
		if r.id == 11 && r.opcode == 2 {
			if len(r.body) != 12 || binary.NativeEndian.Uint32(r.body[4:]) != 273 {
				t.Fatal("wrong evdev right button")
			}
			states = append(states, binary.NativeEndian.Uint32(r.body[8:]))
		}
		if r.id == 11 && r.opcode == 8 {
			destroyed = true
		}
	}
	if !motion || len(states) != 2 || states[0] != 1 || states[1] != 0 || !destroyed {
		t.Fatal("pointer did not release input", all)
	}
}
func TestWaylandRejectsMalformedFramesAndCompositorErrors(t *testing.T) {
	for _, header := range [][]byte{wlWords(2, 4<<16), wlWords(1, 8<<16), wlWords(2, 9<<16)} {
		client, server := net.Pipe()
		client.SetDeadline(time.Now().Add(time.Second))
		server.SetDeadline(time.Now().Add(time.Second))
		go func() {
			defer server.Close()
			request := make([]byte, 12)
			io.ReadFull(server, request)
			server.Write(header)
		}()
		w := &waylandClient{conn: client, next: 3, globals: map[string]waylandGlobal{}}
		if e := w.sync(); e == nil {
			t.Fatal("accepted malformed compositor response")
		}
		w.Close()
	}
	for _, body := range [][]byte{wlWords(4096), append(wlWords(1), []byte{'x', 0, 0, 0}...), wlWords(0)} {
		if _, _, e := readWLString(body); e == nil {
			t.Fatal("invalid string accepted")
		}
	}
}
