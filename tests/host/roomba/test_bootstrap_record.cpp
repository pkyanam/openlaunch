#include <assert.h>
#include <stdint.h>
#include <string.h>
#include <vector>

#include "RoombaBootstrapRecord.h"

struct Memory {
  explicit Memory(size_t size) : bytes(size, 0), failAfter(-1) {}
  std::vector<uint8_t> bytes;
  long failAfter;
};

struct Storage {
  explicit Storage(Memory& memory) : memory(&memory) {}
  size_t length() const { return memory->bytes.size(); }
  void readBlock(size_t offset, void* out, size_t count) const {
    memcpy(out, memory->bytes.data() + offset, count);
  }
  void writeBlock(size_t offset, const void* in, size_t count) {
    size_t written = count;
    if (memory->failAfter >= 0 && static_cast<size_t>(memory->failAfter) < written)
      written = static_cast<size_t>(memory->failAfter);
    memcpy(memory->bytes.data() + offset, in, written);
    if (memory->failAfter >= 0) memory->failAfter = -1;
  }
  Memory* memory;
};

int main() {
  const char* workspace = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const char* token = "ol_sdk_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const char* requestId = "12345678-1234-4234-8234-123456789abc";
  const size_t configAndJournalsEnd = 1408;
  Memory memory(configAndJournalsEnd + sizeof(RoombaBootstrapRecord));
  RoombaBootstrapStore<Storage> store(Storage(memory), configAndJournalsEnd);
  RoombaBootstrapRecord record{};
  assert(store.load(record, workspace) == RoombaBootstrapState::Empty);

  // Configuration code persists this immutable request identity before the
  // first HTTP request. A restart loads the same authorization, UUID and age.
  assert(store.begin(token, requestId, 1900000000000ULL, workspace));
  RoombaBootstrapStore<Storage> afterRestart(Storage(memory), configAndJournalsEnd);
  assert(afterRestart.load(record, workspace) == RoombaBootstrapState::Pending);
  assert(strcmp(record.masterAuthorization, token) == 0);
  assert(strcmp(record.requestId, requestId) == 0);
  assert(record.requestCreatedAtMs == 1900000000000ULL);
  assert(!roombaBootstrapExpired(record, workspace, 1899999999000ULL));
  assert(!afterRestart.begin(token,
      "12345678-1234-4234-8234-123456789abd", 1900000001000ULL, workspace));
  assert(!roombaBootstrapExpired(record, workspace, 1900000600000ULL));
  assert(roombaBootstrapExpired(record, workspace, 1900000600001ULL));

  // Simulate reset after child config readback but before the master journal
  // erase: startup must erase the stale bootstrap record before retry/expiry
  // processing, so a completed attach never gets posted a second time.
  assert(!roombaBootstrapNeedsStartupCleanup(true, false, false));
  Memory interrupted(configAndJournalsEnd + sizeof(RoombaBootstrapRecord));
  RoombaBootstrapStore<Storage> beforePowerLoss(Storage(interrupted), configAndJournalsEnd);
  assert(beforePowerLoss.begin(token, requestId, 1900000000000ULL, workspace));
  const bool childConfigReadBack = true;
  const bool childIdReadBack = true;
  const bool childTokenReadBack = true;
  RoombaBootstrapStore<Storage> afterPowerLoss(Storage(interrupted), configAndJournalsEnd);
  assert(afterPowerLoss.load(record, workspace) == RoombaBootstrapState::Pending);
  assert(roombaBootstrapNeedsStartupCleanup(childConfigReadBack,
      childIdReadBack, childTokenReadBack));
  assert(afterPowerLoss.clear());
  assert(afterPowerLoss.load(record, workspace) == RoombaBootstrapState::Empty);

  // Wrong-workspace and malformed credentials are rejected without storage.
  assert(afterRestart.load(record,
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") ==
      RoombaBootstrapState::Invalid);
  assert(!makeRoombaBootstrapRecord("ol_sdk_bad", requestId, 1, workspace).pending);
  assert(!makeRoombaBootstrapRecord("ol_agent_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", requestId, 1, workspace).pending);
  assert(!makeRoombaBootstrapRecord(token, "bad-id", 1, workspace).pending);

  // Only the caller that has verified and saved child identity clears this
  // board-local master credential. Torn journal writes fail closed.
  assert(afterRestart.clear());
  assert(afterRestart.load(record, workspace) == RoombaBootstrapState::Empty);
  memory.failAfter = 15;
  assert(!store.begin(token, requestId, 1900000000000ULL, workspace));
  assert(store.load(record, workspace) == RoombaBootstrapState::Invalid);
  memory.bytes[configAndJournalsEnd + 12] ^= 1;
  assert(store.load(record, workspace) == RoombaBootstrapState::Invalid);

  Memory shortMemory(configAndJournalsEnd + sizeof(RoombaBootstrapRecord) - 1);
  RoombaBootstrapStore<Storage> shortStore(Storage(shortMemory), configAndJournalsEnd);
  assert(shortStore.load(record, workspace) == RoombaBootstrapState::NoSpace);
}
