#include <assert.h>
#include <stdint.h>
#include <string.h>
#include "RoombaResultJournal.h"

struct FakeEeprom {
  RoombaPendingResult result;
  void put(const RoombaPendingResult& value) { memcpy(&result, &value, sizeof(value)); }
  RoombaPendingResult get() const { return result; }
};

int main() {
  RoombaPendingResult fresh = {};
  assert(emptyRoombaResultJournal(fresh));
  memset(&fresh, 0xFF, sizeof(fresh));
  assert(emptyRoombaResultJournal(fresh));

  const char* id = "12345678-1234-4234-8234-123456789abc";
  const char* payload =
      "{\"actionId\":\"12345678-1234-4234-8234-123456789abc\","
      "\"status\":\"succeeded\",\"result\":{\"accepted\":true,"
      "\"physicalVerified\":false,\"transport\":\"serial_command_sent\"}}";
  const size_t payloadLength = strlen(payload);
  const RoombaPendingResult beforeRestart =
      makeRoombaPendingResult(id, "succeeded", 1900000000000ULL,
                              payload, payloadLength);
  assert(validRoombaPendingResult(beforeRestart));

  // A failed upload leaves EEPROM unchanged. Restart retries the stored result
  // and does not run the hardware action or depend on server redelivery.
  FakeEeprom eeprom = {};
  eeprom.put(beforeRestart);
  RoombaPendingResult afterRestart = eeprom.get();
  assert(validRoombaPendingResult(afterRestart));
  assert(strcmp(afterRestart.actionId, id) == 0);
  assert(strcmp(afterRestart.status, "succeeded") == 0);
  assert(afterRestart.expiresAt == 1900000000000ULL);
  assert(afterRestart.payloadLength == payloadLength);
  assert(strcmp(afterRestart.payload, payload) == 0);
  const char* result = "{\"accepted\":true,\"physicalVerified\":false,"
                       "\"transport\":\"serial_command_sent\"}";
  assert(!roombaResultResponseMatches(afterRestart,
      "12345678-1234-4234-8234-123456789abd", "succeeded", result, result));
  assert(!roombaResultResponseMatches(afterRestart, id, "failed", result, result));
  assert(!roombaResultResponseMatches(afterRestart, id, "succeeded", result,
      "{\"accepted\":false}"));
  assert(roombaResultResponseMatches(afterRestart, id, "succeeded", result, result));

  // Clear only after the matching service response is confirmed.
  RoombaPendingResult cleared = {};
  eeprom.put(cleared);
  assert(emptyRoombaResultJournal(eeprom.get()));

  // A torn/corrupt write fails closed, and oversized results cannot be stored.
  RoombaPendingResult corrupted = beforeRestart;
  corrupted.payload[5] ^= 1;
  assert(!validRoombaPendingResult(corrupted));
  char tooLarge[ROOMBA_RESULT_PAYLOAD_CAPACITY + 2];
  memset(tooLarge, 'x', sizeof(tooLarge) - 1);
  tooLarge[sizeof(tooLarge) - 1] = 0;
  const RoombaPendingResult rejected = makeRoombaPendingResult(
      id, "failed", 1900000000000ULL, tooLarge, strlen(tooLarge));
  assert(!validRoombaPendingResult(rejected));

  // Expired outcomes remain valid journal entries for operator inspection;
  // expiry is handled as an uncertain outcome by the firmware, not replayed.
  const RoombaPendingResult expired =
      makeRoombaPendingResult(id, "failed", 1, payload, payloadLength);
  assert(validRoombaPendingResult(expired));
  assert(expired.expiresAt == 1);
}
