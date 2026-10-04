#include <cassert>
#include <cstdint>

#include "RoombaDriveAdapter.h"
#include "RoombaCommandGuard.h"

class FakeDriveIO : public RoombaDriveIO {
 public:
  uint32_t now = 0;
  uint16_t tickMs = 1;
  int disarmAt = -1;
  int armedChecks = 0;
  int driveCalls = 0;
  int stopCalls = 0;
  int16_t velocity = 0;
  int16_t radius = 0;
  bool armed = true;

  uint32_t nowMs() override {
    const uint32_t result = now;
    now += tickMs;
    return result;
  }
  bool locallyArmed() override {
    ++armedChecks;
    if (disarmAt >= 0 && armedChecks >= disarmAt) armed = false;
    return armed;
  }
  void drive(int16_t v, int16_t r) override {
    ++driveCalls;
    velocity = v;
    radius = r;
  }
  void stop() override { ++stopCalls; }
};

int main() {
  {
    RoombaMotionRecord record = makeRoombaMotionRecord(1700000000000ULL);
    assert(!roombaTimestampIsNew(1700000000000ULL, record));
    assert(!roombaTimestampIsNew(1699999999999ULL, record));
    assert(roombaTimestampIsNew(1700000000001ULL, record));
  }
  {
    FakeDriveIO io;
    RoombaDriveAdapter adapter(io);
    assert(adapter.run(150, -2000, 1000) == RoombaDriveResult::COMPLETED);
    assert(io.driveCalls == 1 && io.stopCalls == 1);
    assert(io.velocity == 150 && io.radius == -2000);
    assert(io.now >= 1000);
  }
  {
    FakeDriveIO io;
    io.now = 0xfffffff0u;  // Duration arithmetic must tolerate millis wrap.
    RoombaDriveAdapter adapter(io);
    assert(adapter.run(-100, 0, 20) == RoombaDriveResult::COMPLETED);
    assert(io.stopCalls == 1);
  }
  {
    FakeDriveIO io;
    RoombaDriveAdapter adapter(io);
    assert(adapter.run(100, 0, 10) == RoombaDriveResult::COMPLETED);
    assert(io.radius == static_cast<int16_t>(-32768));
  }
  {
    FakeDriveIO io;
    io.disarmAt = 3;
    RoombaDriveAdapter adapter(io);
    assert(adapter.run(80, 1, 500) == RoombaDriveResult::DISARMED);
    assert(io.driveCalls == 1 && io.stopCalls == 1);
  }
  {
    FakeDriveIO io;
    io.armed = false;
    RoombaDriveAdapter adapter(io);
    assert(adapter.run(80, 1, 500) == RoombaDriveResult::DISARMED);
    assert(io.driveCalls == 0 && io.stopCalls == 1);
  }
  {
    FakeDriveIO io;
    RoombaDriveAdapter adapter(io);
    assert(adapter.run(151, 0, 100) == RoombaDriveResult::INVALID_ARGUMENT);
    assert(io.driveCalls == 0 && io.stopCalls == 1);
    io.stopCalls = 0;
    assert(adapter.run(0, 2001, 100) == RoombaDriveResult::INVALID_ARGUMENT);
    assert(io.driveCalls == 0 && io.stopCalls == 1);
    io.stopCalls = 0;
    assert(adapter.run(0, 0, 1001) == RoombaDriveResult::INVALID_ARGUMENT);
    assert(io.driveCalls == 0 && io.stopCalls == 1);
    io.stopCalls = 0;
    assert(adapter.run(0, 0, 0) == RoombaDriveResult::INVALID_ARGUMENT);
    assert(io.driveCalls == 0 && io.stopCalls == 1);
  }
  return 0;
}
