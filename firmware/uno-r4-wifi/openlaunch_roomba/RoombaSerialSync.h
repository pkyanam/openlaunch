#ifndef OPENLAUNCH_ROOMBA_SERIAL_SYNC_H
#define OPENLAUNCH_ROOMBA_SERIAL_SYNC_H

#include <stdint.h>

static const uint16_t ROOMBA_RX_MAX_DRAIN_BYTES = 2048;
static const uint16_t ROOMBA_RX_DRAIN_TIMEOUT_MS = 100;
static const uint16_t ROOMBA_RX_QUIET_MS = 20;

struct RoombaSerialSyncResult {
  bool ready;
  uint16_t discardedBytes;
};

// Drain unsolicited startup text before a sensor query. Require a quiet
// interval, not an instant empty buffer. Time and byte budgets bound noise;
// this cannot resolve the ambiguity of a previous timed-out query.
template <typename SerialPort, typename Clock>
RoombaSerialSyncResult synchronizeRoombaSerial(SerialPort* serial, Clock& clock) {
  if (!serial || !serial->isActive()) return {false, 0};
  const uint32_t startedAt = clock.nowMs();
  uint32_t lastByteAt = startedAt;
  uint16_t discarded = 0;
  while (static_cast<uint32_t>(clock.nowMs() - startedAt) < ROOMBA_RX_DRAIN_TIMEOUT_MS) {
    if (serial->available() > 0) {
      if (discarded >= ROOMBA_RX_MAX_DRAIN_BYTES) return {false, discarded};
      serial->read();
      ++discarded;
      lastByteAt = clock.nowMs();
    } else {
      if (static_cast<uint32_t>(clock.nowMs() - lastByteAt) >= ROOMBA_RX_QUIET_MS)
        return {true, discarded};
      clock.pause();
    }
  }
  return {false, discarded};
}

#endif
