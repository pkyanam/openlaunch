#include <assert.h>
#include "RoombaLocalControl.h"
#include "RoombaSerialSync.h"

struct Clock {
  uint32_t now = 0;
  uint32_t nowMs() { return now; }
  void pause() { ++now; }
};
struct Port {
  bool active = true, continuous = false;
  int pending = 0;
  Clock* clock = nullptr;
  bool trickle = false;
  uint32_t lastTrickle = 0;
  bool isActive() { return active; }
  int available() {
    if (trickle && clock->now != lastTrickle && clock->now % 10 == 0) {
      lastTrickle = clock->now;
      ++pending;
    }
    return continuous ? 1 : pending;
  }
  int read() { if (pending > 0) --pending; return 0; }
};

int main() {
  RoombaLocalControl serialOnly(false), contacts(true);
  assert(serialOnly.allows(true, false, false));
  assert(!serialOnly.allows(false, true, true));
  assert(!contacts.allows(true, true, true)); // Held enable at boot cannot arm.
  assert(!contacts.allows(true, false, true));
  assert(contacts.allows(true, true, true));
  assert(!contacts.allows(true, true, false));
  assert(!contacts.allows(true, true, true)); // Stop requires fresh enable release.
  assert(!contacts.allows(true, false, true));
  assert(contacts.allows(true, true, true));
  assert(!contacts.allows(false, true, true));

  Clock clock;
  Port port;
  port.pending = 512;
  auto result = synchronizeRoombaSerial(&port, clock);
  assert(result.ready && result.discardedBytes == 512);
  assert(clock.now == ROOMBA_RX_QUIET_MS);
  port.continuous = true;
  result = synchronizeRoombaSerial(&port, clock);
  assert(!result.ready && result.discardedBytes == ROOMBA_RX_MAX_DRAIN_BYTES);
  port.continuous = false;
  port.trickle = true; port.clock = &clock;
  const uint32_t started = clock.now;
  result = synchronizeRoombaSerial(&port, clock);
  assert(!result.ready && clock.now - started == ROOMBA_RX_DRAIN_TIMEOUT_MS);
  port.trickle = false;
  clock.now = 0xfffffff0u;
  result = synchronizeRoombaSerial(&port, clock);
  assert(result.ready && clock.now == 4); // Quiet-time arithmetic survives wrap.
  port.active = false;
  assert(!synchronizeRoombaSerial(&port, clock).ready);
  assert(!synchronizeRoombaSerial<Port>(nullptr, clock).ready);
}
