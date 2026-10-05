package main

import (
	"context"
	"time"
)

// Presence is independent of dispatch and the durable result journal. This
// fallback sends no requests for short operations or while the poller is idle.
// It also covers a long command when the optional WebSocket is unavailable.
func withDevicePresence(ctx context.Context, c Config, interval time.Duration, operation func() error) error {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				request, stop := context.WithTimeout(ctx, 10*time.Second)
				// A lost heartbeat cannot replay/extend an already admitted command.
				// Canonical dispatch/result requests still enforce revocation and expiry.
				_ = callContext(request, c, "/v1/device/"+c.DeviceID+"/heartbeat", map[string]any{}, nil)
				stop()
			}
		}
	}()
	defer func() { cancel(); <-done }()
	return operation()
}
