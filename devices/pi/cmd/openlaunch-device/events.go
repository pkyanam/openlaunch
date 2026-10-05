package main

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const deviceEventsProtocol = "openlaunch.device.v1"

var eventHex = regexp.MustCompile(`^[a-f0-9]{64}$`)
var eventDeviceID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

// A hint only wakes the existing HTTPS poller. It contains no command and
// cannot authorize execution, skip expiry, or bypass result reconciliation.
func startDeviceEvents(ctx context.Context, c Config) <-chan struct{} {
	wake := make(chan struct{}, 1)
	if validateURL(c.URL) != nil || !eventHex.MatchString(c.Workspace) || !eventDeviceID.MatchString(c.DeviceID) {
		return wake
	}
	go func() {
		backoff := time.Second
		for ctx.Err() == nil {
			started := time.Now()
			_ = deviceEventSession(ctx, c, wake, 25*time.Second, 10*time.Second)
			if time.Since(started) >= 30*time.Second {
				backoff = time.Second
			}
			// Failed optional sockets never interrupt ordinary HTTP polling.
			wait := backoff*3/4 + time.Duration(rand.Int64N(int64(backoff/2)+1))
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			backoff = min(backoff*2, 30*time.Second)
		}
	}()
	return wake
}

func deviceEventSession(ctx context.Context, c Config, wake chan<- struct{}, pingInterval, pongTimeout time.Duration) error {
	var ticket struct {
		Ticket    string `json:"ticket"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	ticketContext, cancelTicket := context.WithTimeout(ctx, 10*time.Second)
	err := callContext(ticketContext, c, "/v1/device/"+c.DeviceID+"/events-ticket", map[string]any{}, &ticket)
	cancelTicket()
	if err != nil {
		return errors.New("event ticket unavailable")
	}
	if !eventHex.MatchString(ticket.Ticket) || ticket.ExpiresAt <= time.Now().UnixMilli() {
		return errors.New("invalid event ticket")
	}
	target, _ := url.Parse(strings.TrimRight(c.URL, "/") + "/v1/device/" + c.DeviceID + "/events")
	if target.Scheme == "https" {
		target.Scheme = "wss"
	} else {
		target.Scheme = "ws"
	}
	query := url.Values{"workspace": {c.Workspace}}
	target.RawQuery = query.Encode()
	// No bearer credential or ticket in the URL. Redirects remain forbidden.
	socketClient := *httpClient
	socketClient.Timeout = 0
	dialContext, cancelDial := context.WithTimeout(ctx, 10*time.Second)
	conn, response, err := websocket.Dial(dialContext, target.String(), &websocket.DialOptions{
		HTTPClient:   &socketClient,
		HTTPHeader:   http.Header{"X-Openlaunch-Workspace": {c.Workspace}},
		Subprotocols: []string{deviceEventsProtocol, "ticket." + ticket.Ticket},
	})
	cancelDial()
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err != nil {
		return errors.New("event channel unavailable")
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != deviceEventsProtocol {
		return errors.New("invalid event protocol")
	}
	conn.SetReadLimit(256)
	sessionContext, cancelSession := context.WithCancel(ctx)
	defer cancelSession()
	frames := make(chan string, 1)
	readDone := make(chan error, 1)
	go func() {
		for {
			kind, data, e := conn.Read(sessionContext)
			if e != nil {
				readDone <- e
				return
			}
			if kind != websocket.MessageText {
				continue
			}
			select {
			case frames <- string(data):
			case <-sessionContext.Done():
				return
			}
		}
	}()
	notify := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	notify() // Catch queued work that predates the subscription.
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	var pongDeadline <-chan time.Time
	var pongTimer *time.Timer
	defer func() {
		if pongTimer != nil {
			pongTimer.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readDone:
			return err
		case <-pongDeadline:
			return errors.New("event heartbeat timeout")
		case <-ping.C:
			if pongDeadline != nil {
				continue
			}
			writeContext, cancelWrite := context.WithTimeout(ctx, pongTimeout)
			err := conn.Write(writeContext, websocket.MessageText, []byte("openlaunch.ping"))
			cancelWrite()
			if err != nil {
				return errors.New("event heartbeat unavailable")
			}
			pongTimer = time.NewTimer(pongTimeout)
			pongDeadline = pongTimer.C
		case data := <-frames:
			if data == "openlaunch.pong" {
				if pongTimer != nil {
					pongTimer.Stop()
				}
				pongDeadline = nil
				continue
			}
			var hint struct {
				Type string `json:"type"`
			}
			if json.Unmarshal([]byte(data), &hint) == nil && hint.Type == "work" {
				notify()
			}
		}
	}
}
