#ifndef OPENLAUNCH_ATTACHMENT_CLOCK_H
#define OPENLAUNCH_ATTACHMENT_CLOCK_H

#include <stdint.h>

enum class OpenLaunchAttachmentClock { Waiting, Ready, Expired };

inline OpenLaunchAttachmentClock openLaunchAttachmentClock(
    uint64_t nowMs, uint64_t createdAtMs, uint64_t windowMs) {
  // WiFi.getTime() has second precision; the USB host supplies milliseconds.
  // An earlier board clock must defer pairing without replacing its request ID.
  if (nowMs < createdAtMs) return OpenLaunchAttachmentClock::Waiting;
  return nowMs - createdAtMs >= windowMs
      ? OpenLaunchAttachmentClock::Expired
      : OpenLaunchAttachmentClock::Ready;
}

#endif
