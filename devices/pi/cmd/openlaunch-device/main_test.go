package main

import (
	"testing"
	"time"
)

func TestURL(t *testing.T) {
	for _, s := range []string{"http://example.com", "https://u:p@example.com", "https://example.com?token=x"} {
		if validateURL(s) == nil {
			t.Fatal("accepted", s)
		}
	}
	for _, s := range []string{"https://openlaunch.dev", "http://127.0.0.1:8788"} {
		if validateURL(s) != nil {
			t.Fatal("rejected", s)
		}
	}
}
func TestNoUnregisteredHardwareAction(t *testing.T) {
	r := execute(Config{}, Command{Capability: "led.set", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, time.Now())
	if r.Status != "failed" {
		t.Fatal("unimplemented hardware action succeeded")
	}
}
func TestExpired(t *testing.T) {
	r := execute(Config{Simulate: true}, Command{Capability: "led.set", ExpiresAt: 1}, time.Now())
	if r.Status != "failed" {
		t.Fatal("expired action executed")
	}
}
