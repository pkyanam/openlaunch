#include <cassert>
#include <cstdint>
#include <limits>

#include "RoombaCommandGuard.h"

int main() {
  const RoombaMotionRecord first = makeRoombaMotionRecord(1700000000000ULL);
  assert(validRoombaMotionRecord(first));
  assert(!roombaTimestampIsNew(1700000000000ULL, first));
  assert(!roombaTimestampIsNew(1699999999999ULL, first));
  assert(roombaTimestampIsNew(1700000000001ULL, first));

  // Copying the EEPROM record models restart persistence.
  const RoombaMotionRecord afterRestart = first;
  assert(!roombaTimestampIsNew(1700000000000ULL, afterRestart));
  RoombaMotionRecord damaged = first;
  damaged.lastCreatedAt++;
  assert(!validRoombaMotionRecord(damaged));
  assert(!roombaTimestampIsNew(1700000000002ULL, damaged));
  damaged = first;
  damaged.magic ^= 1;
  assert(!validRoombaMotionRecord(damaged));

  uint64_t parsed = 0;
  assert(parseRoombaUnsignedInteger(1700000000123.0, parsed));
  assert(parsed == 1700000000123ULL);
  assert(!parseRoombaUnsignedInteger(-1.0, parsed));
  assert(!parseRoombaUnsignedInteger(1.5, parsed));
  assert(!parseRoombaUnsignedInteger(9007199254740992.0, parsed));
  assert(!parseRoombaUnsignedInteger(std::numeric_limits<double>::infinity(), parsed));

  // Whole-second board time needs duration plus a one-second reserve.
  assert(roombaHasExecutionBudget(1700000000ULL, 1700000002001ULL, 1000));
  assert(!roombaHasExecutionBudget(1700000000ULL, 1700000002000ULL, 1000));
  assert(!roombaHasExecutionBudget(1700000000ULL, 1700000001500ULL, 1000));
  assert(!roombaHasExecutionBudget(1699999999ULL, 1800000000000ULL, 100));
  return 0;
}
