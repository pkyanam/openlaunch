#ifndef OPENLAUNCH_ROOMBA_LINK_H
#define OPENLAUNCH_ROOMBA_LINK_H

#include <ArduRoomba.h>
#include "RoombaSerialSync.h"
#include "RoombaDriveAdapter.h"

struct RoombaSensorClock {
  uint32_t nowMs() { return millis(); }
  void pause() { delay(1); }
};

// OI has no response framing. A timed-out query must not be retried against
// a possibly late reply; restart the adapter after waking/checking the robot.
static bool roombaSensorLinkDesynced = false;
static bool roombaLinkVerified = false;
static uint8_t roombaOiMode = 255;
static uint32_t roombaLinkCheckedAtMs = 0;
static uint16_t roombaLinkDiscardedBytes = 0;
static const char* roombaLinkError = "not_checked";
static const uint16_t ROOMBA_CONTROL_PREPARE_MS = 3200;
static const uint16_t ROOMBA_WARM_CONTROL_PREPARE_MS = 400;
static const uint32_t ROOMBA_AWAKE_CACHE_MS = 60000;

// This cache only avoids repeated BRC wake/baud delays. Every control still
// requests a fresh OI reply before sending outputs. Never retry a timed-out
// unframed query, even if the cached reply was recent.
inline bool roombaNeedsWake(uint32_t nowMs) {
  return roombaSensorLinkDesynced || !roombaLinkVerified ||
      (roombaOiMode != 1 && roombaOiMode != 2) ||
      static_cast<uint32_t>(nowMs - roombaLinkCheckedAtMs) >= ROOMBA_AWAKE_CACHE_MS;
}

inline uint16_t roombaControlPrepareMs() {
  return roombaNeedsWake(millis()) ? ROOMBA_CONTROL_PREPARE_MS
                                 : ROOMBA_WARM_CONTROL_PREPARE_MS;
}

inline void returnRoombaToPassiveIdle(ArduRoomba& roomba) {
  // Call only after sending zero wheel/brush outputs. Start (128) enables
  // Passive OI without starting cleaning; leaving Safe mode permits charging.
  roomba.serial()->write(static_cast<uint8_t>(128));
  roomba.serial()->flush();
  delay(20);
}

template <typename Pin, typename Clock>
void wakeAndSelectRoombaBaud(Pin& pin, Clock& clock) {
  pin.set(true);
  pin.set(false); clock.wait(100); pin.set(true); // Separate wake pulse.
  clock.wait(2000); // Robot wake, not merely time since the Uno booted.
  for (uint8_t i = 0; i < 3; ++i) {
    pin.set(false); clock.wait(100); pin.set(true); clock.wait(100);
  }
  clock.wait(100);
}

inline bool verifyRoombaLink(ArduRoomba& roomba) {
  roombaLinkVerified = false;
  roombaOiMode = 255;
  roombaLinkCheckedAtMs = millis();
  roombaLinkDiscardedBytes = 0;
  if (roombaSensorLinkDesynced) {
    roombaLinkError = "serial_link_desynced";
    return false;
  }
  RoombaSensorClock clock;
  const auto sync = synchronizeRoombaSerial(roomba.serial(), clock);
  roombaLinkDiscardedBytes = sync.discardedBytes;
  if (!sync.ready) {
    roombaLinkError = "serial_rx_backlog";
    return false;
  }
  uint8_t mode = 255;
  if (!roomba.sensors().getSensor(35, &mode, 1)) {
    roombaSensorLinkDesynced = true;
    roombaLinkError = "serial_timeout";
    return false;
  }
  if (mode > 3 || roomba.serial()->available() > 0) {
    roombaSensorLinkDesynced = true;
    roombaLinkError = "invalid_oi_response";
    return false;
  }
  roombaLinkVerified = true;
  roombaOiMode = mode;
  roombaLinkError = mode == 0 ? "roomba_oi_off" : mode == 3 ? "unexpected_full_mode" : "";
  return mode == 1 || mode == 2;
}

inline bool prepareRoombaControl(ArduRoomba& roomba, RoombaDriveIO& io,
                                 bool requireSafe, uint16_t outputMs,
                                 const char*& error) {
  if (roombaSensorLinkDesynced) {
    roombaLinkVerified = false;
    roombaLinkError = "serial_link_desynced";
    error = "serial_link_desynced";
    return false;
  }
  const bool needsWake = roombaNeedsWake(millis());
  const uint16_t prepareMs = needsWake ? ROOMBA_CONTROL_PREPARE_MS
                                      : ROOMBA_WARM_CONTROL_PREPARE_MS;
  if (!io.controlWindowAvailable(prepareMs + outputMs)) {
    error = "clock_unavailable_or_expired";
    return false;
  }
  if (!io.locallyArmed()) { error = "control_not_ready"; return false; }
  if (needsWake) io.wakeForControl();
  if (!io.locallyArmed()) { error = "control_not_ready"; return false; }
  if (!roomba.resumeControl()) { roombaLinkVerified = false; error = "resume_failed"; return false; }
  if (!verifyRoombaLink(roomba)) { error = roombaLinkError; return false; }
  if (requireSafe && roombaOiMode != 2) {
    error = "roomba_safe_mode_unavailable";
    return false;
  }
  // Recheck expiry and the local permit after the bounded initialization.
  if (!io.controlWindowAvailable(outputMs)) {
    error = "clock_unavailable_or_expired";
    return false;
  }
  if (!io.locallyArmed()) { error = "control_not_ready"; return false; }
  return true;
}

#endif
