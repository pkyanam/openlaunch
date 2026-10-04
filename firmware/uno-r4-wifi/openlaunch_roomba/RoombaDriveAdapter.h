#ifndef OPENLAUNCH_ROOMBA_DRIVE_ADAPTER_H
#define OPENLAUNCH_ROOMBA_DRIVE_ADAPTER_H

#include <stdint.h>

// Hardware-independent guard around ArduRoomba's persistent drive command.
// A burst is capped at one second and always sends stop before returning.
class RoombaDriveIO {
 public:
  virtual ~RoombaDriveIO() {}
  virtual uint32_t nowMs() = 0;
  virtual bool locallyArmed() = 0;
  virtual void drive(int16_t velocityMmS, int16_t radiusMm) = 0;
  virtual void stop() = 0;
};

enum class RoombaDriveResult : uint8_t {
  COMPLETED,
  DISARMED,
  INVALID_ARGUMENT
};

class RoombaDriveAdapter {
 public:
  explicit RoombaDriveAdapter(RoombaDriveIO& io) : io_(io) {}

  // API radiusMm 0 means straight. The Open Interface uses -32768 for that
  // special case; radius +/-1 is a spin in place.

  RoombaDriveResult run(int16_t velocityMmS, int16_t radiusMm,
                        uint16_t durationMs) {
    if (velocityMmS < -150 || velocityMmS > 150 ||
        radiusMm < -2000 || radiusMm > 2000 ||
        durationMs == 0 || durationMs > 1000) {
      io_.stop();
      return RoombaDriveResult::INVALID_ARGUMENT;
    }
    if (!io_.locallyArmed()) {
      io_.stop();
      return RoombaDriveResult::DISARMED;
    }

    const uint32_t startedAt = io_.nowMs();
    io_.drive(velocityMmS, radiusMm == 0 ? static_cast<int16_t>(-32768) : radiusMm);
    while (static_cast<uint32_t>(io_.nowMs() - startedAt) < durationMs) {
      if (!io_.locallyArmed()) {
        io_.stop();
        return RoombaDriveResult::DISARMED;
      }
    }
    io_.stop();
    return RoombaDriveResult::COMPLETED;
  }

  void stop() { io_.stop(); }

 private:
  RoombaDriveIO& io_;
};

#endif
