#include <assert.h>
#include <stdint.h>
#include <string.h>
#include <vector>

#include "../../../firmware/uno-r4-wifi/openlaunch/ResultJournal.h"

struct FakeMemory {
  explicit FakeMemory(size_t size) : bytes(size, 0), failAfter(-1) {}
  std::vector<uint8_t> bytes;
  long failAfter;
};

struct FakeStorage {
  explicit FakeStorage(FakeMemory& memory) : memory(&memory) {}
  size_t length() const { return memory->bytes.size(); }
  void readBlock(size_t offset, void* out, size_t count) const {
    memcpy(out, memory->bytes.data() + offset, count);
  }
  void writeBlock(size_t offset, const void* in, size_t count) {
    const uint8_t* source = static_cast<const uint8_t*>(in);
    size_t writable = count;
    if (memory->failAfter >= 0 && static_cast<size_t>(memory->failAfter) < writable)
      writable = static_cast<size_t>(memory->failAfter);
    memcpy(memory->bytes.data() + offset, source, writable);
    if (memory->failAfter >= 0) memory->failAfter = -1;
  }
  FakeMemory* memory;
};

static const char* kAction = "12345678-1234-4234-8234-123456789abc";
static const char* kPayload =
    "{\"actionId\":\"12345678-1234-4234-8234-123456789abc\","
    "\"status\":\"succeeded\",\"result\":{\"on\":true}}";

int main() {
  const size_t configBytes = 240;
  FakeMemory memory(configBytes + sizeof(OpenLaunchResultRecord));
  memset(memory.bytes.data(), 0xA5, configBytes); // Config region is owned elsewhere.
  OpenLaunchResultJournal<FakeStorage> journal(FakeStorage(memory), configBytes);
  OpenLaunchResultRecord record{};
  assert(journal.load(record) == OpenLaunchJournalState::Empty);

  // Intent is read back before effects may run. Restart sees uncertainty and
  // cannot begin a second action or recover by waiting for redelivery.
  assert(journal.begin(kAction, 1900000000000ULL));
  assert(journal.load(record) == OpenLaunchJournalState::Intent);
  OpenLaunchResultJournal<FakeStorage> afterPowerLoss(FakeStorage(memory), configBytes);
  assert(afterPowerLoss.load(record) == OpenLaunchJournalState::Intent);
  assert(!afterPowerLoss.begin("12345678-1234-4234-8234-123456789abd", 1900000000001ULL));
  assert(record.expiresAt == 1900000000000ULL);

  // The serialized outcome remains available after failed upload and restart;
  // it blocks polling and cannot be cleared with a mismatched acknowledgement.
  assert(journal.saveOutcome(kAction, 1900000000000ULL, kPayload, strlen(kPayload)));
  assert(afterPowerLoss.load(record) == OpenLaunchJournalState::Saved);
  assert(strcmp(record.payload, kPayload) == 0);
  assert(!afterPowerLoss.begin("12345678-1234-4234-8234-123456789abd", 1900000000001ULL));
  assert(!afterPowerLoss.clearMatching("12345678-1234-4234-8234-123456789abd",
                                       kPayload, strlen(kPayload)));
  assert(!afterPowerLoss.clearMatching(kAction, "{}", 2));

  // Expiry leaves the outcome retained as uncertain; only a matching
  // acknowledged action/status/result payload can clear it.
  assert(openLaunchResultExpired(record, 1900000000000ULL));
  assert(afterPowerLoss.load(record) == OpenLaunchJournalState::Saved);
  assert(afterPowerLoss.clearMatching(kAction, kPayload, strlen(kPayload)));
  assert(afterPowerLoss.load(record) == OpenLaunchJournalState::Empty);
  for (size_t i = 0; i < configBytes; ++i) assert(memory.bytes[i] == 0xA5);

  // A permanent upload rejection/expiry is itself durable across reboot and
  // cannot resume polling until an explicit owner reset clears the journal.
  assert(journal.begin(kAction, 1900000000000ULL));
  assert(journal.saveOutcome(kAction, 1900000000000ULL, kPayload, strlen(kPayload)));
  assert(journal.halt(kAction));
  assert(afterPowerLoss.load(record) == OpenLaunchJournalState::Halted);
  assert(!afterPowerLoss.begin("12345678-1234-4234-8234-123456789abd", 1900000000001ULL));

  // Torn writes, checksum damage, and insufficient EEPROM all fail closed.
  // Model an explicit reset before simulating a torn new intent.
  memset(memory.bytes.data() + configBytes, 0, sizeof(OpenLaunchResultRecord));
  memory.failAfter = 19;
  assert(!journal.begin(kAction, 1900000000000ULL));
  assert(journal.load(record) == OpenLaunchJournalState::Invalid);
  FakeMemory damaged(configBytes + sizeof(OpenLaunchResultRecord));
  OpenLaunchResultJournal<FakeStorage> damagedJournal(FakeStorage(damaged), configBytes);
  assert(damagedJournal.begin(kAction, 1900000000000ULL));
  assert(damagedJournal.saveOutcome(kAction, 1900000000000ULL,
                                    kPayload, strlen(kPayload)));
  damaged.bytes[configBytes + 20] ^= 1;
  assert(damagedJournal.load(record) == OpenLaunchJournalState::Invalid);
  FakeMemory shortMemory(configBytes + sizeof(OpenLaunchResultRecord) - 1);
  OpenLaunchResultJournal<FakeStorage> shortJournal(FakeStorage(shortMemory), configBytes);
  assert(shortJournal.load(record) == OpenLaunchJournalState::NoSpace);

  // Corrupted EEPROM must never make action-ID validation scan beyond the
  // fixed-size field searching for a terminator.
  OpenLaunchResultRecord unterminated{};
  unterminated.magic = OPENLAUNCH_RESULT_JOURNAL_MAGIC;
  unterminated.state = OPENLAUNCH_RESULT_INTENT;
  memset(unterminated.actionId, 'a', sizeof(unterminated.actionId));
  unterminated.actionId[8] = '-';
  unterminated.actionId[13] = '-';
  unterminated.actionId[18] = '-';
  unterminated.actionId[23] = '-';
  unterminated.expiresAt = 1900000000000ULL;
  unterminated.checksum = openLaunchResultChecksum(unterminated);
  assert(!openLaunchValidActionId(unterminated.actionId,
                                  sizeof(unterminated.actionId)));
  assert(!openLaunchValidResultRecord(unterminated));
}
