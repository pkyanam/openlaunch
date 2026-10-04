#ifndef OPENLAUNCH_ROOMBA_BOOTSTRAP_RECORD_H
#define OPENLAUNCH_ROOMBA_BOOTSTRAP_RECORD_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static const uint32_t ROOMBA_BOOTSTRAP_MAGIC = 0x52425332UL;
static const uint16_t ROOMBA_BOOTSTRAP_VERSION = 1;
static const uint8_t ROOMBA_BOOTSTRAP_PENDING = 1;

struct RoombaBootstrapRecord {
  uint32_t magic;
  uint16_t version;
  uint8_t pending;
  uint8_t reserved;
  char masterAuthorization[139];
  char requestId[37];
  uint64_t requestCreatedAtMs;
  uint32_t checksum;
};

enum class RoombaBootstrapState : uint8_t { Empty, Pending, Invalid, NoSpace };

// A reset can happen after child identity readback but before the old master
// authorization is erased. On restart, a validated paired configuration must
// always take the cleanup path and must never retry the bootstrap request.
inline bool roombaBootstrapNeedsStartupCleanup(bool configIsValid,
                                               bool hasChildId,
                                               bool hasChildToken) {
  return configIsValid && hasChildId && hasChildToken;
}

inline bool roombaBoundedStringLength(const char* value, size_t capacity,
                                      size_t& length) {
  if (!value) return false;
  const char* end = static_cast<const char*>(memchr(value, '\0', capacity));
  if (!end) return false;
  length = static_cast<size_t>(end - value);
  return true;
}

inline bool roombaValidRequestId(const char* id, size_t capacity = 37) {
  size_t length = 0;
  if (capacity < 37 || !roombaBoundedStringLength(id, capacity, length) || length != 36)
    return false;
  for (size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') return false;
    } else if (!((id[i] >= '0' && id[i] <= '9') ||
                 (id[i] >= 'a' && id[i] <= 'f'))) return false;
  }
  return true;
}

inline bool roombaMasterWorkspace(const char* token, size_t capacity,
                                  char workspace[65]) {
  size_t length = 0;
  if (!roombaBoundedStringLength(token, capacity, length) ||
      length != 136) return false;
  size_t prefix = 0;
  if (strncmp(token, "ol_sdk_", 7) == 0) prefix = 7;
  else return false;
  if (length != prefix + 64 + 1 + 64 || token[prefix + 64] != '_') return false;
  for (size_t i = 0; i < 64; ++i) {
    const char c = token[prefix + i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    workspace[i] = c;
  }
  workspace[64] = '\0';
  for (size_t i = prefix + 65; i < length; ++i)
    if (!((token[i] >= '0' && token[i] <= '9') ||
          (token[i] >= 'a' && token[i] <= 'f'))) return false;
  return true;
}

inline uint32_t roombaBootstrapChecksum(const RoombaBootstrapRecord& record) {
  uint32_t crc = 0xFFFFFFFFUL;
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  for (size_t i = 0; i < offsetof(RoombaBootstrapRecord, checksum); ++i) {
    crc ^= bytes[i];
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xEDB88320UL & (-(int32_t)(crc & 1)));
  }
  return ~crc;
}

inline bool emptyRoombaBootstrapRecord(const RoombaBootstrapRecord& record) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  bool allZero = true;
  bool allErased = true;
  for (size_t i = 0; i < sizeof(record); ++i) {
    allZero = allZero && bytes[i] == 0;
    allErased = allErased && bytes[i] == 0xFF;
  }
  return allZero || allErased;
}

inline bool validRoombaBootstrapRecord(const RoombaBootstrapRecord& record,
                                       const char* configuredWorkspace) {
  char tokenWorkspace[65] = {};
  if (record.magic != ROOMBA_BOOTSTRAP_MAGIC ||
      record.version != ROOMBA_BOOTSTRAP_VERSION ||
      record.pending != ROOMBA_BOOTSTRAP_PENDING || record.reserved != 0 ||
      !roombaMasterWorkspace(record.masterAuthorization,
                             sizeof(record.masterAuthorization), tokenWorkspace) ||
      !configuredWorkspace || strcmp(tokenWorkspace, configuredWorkspace) != 0 ||
      !roombaValidRequestId(record.requestId, sizeof(record.requestId)) ||
      record.requestCreatedAtMs == 0)
    return false;
  return record.checksum == roombaBootstrapChecksum(record);
}

inline bool roombaBootstrapExpired(const RoombaBootstrapRecord& record,
                                   const char* configuredWorkspace,
                                   uint64_t nowMs) {
  return validRoombaBootstrapRecord(record, configuredWorkspace) &&
      nowMs >= record.requestCreatedAtMs &&
      nowMs - record.requestCreatedAtMs > 600000ULL;
}

inline RoombaBootstrapRecord makeRoombaBootstrapRecord(
    const char* masterAuthorization, const char* requestId,
    uint64_t requestCreatedAtMs, const char* configuredWorkspace) {
  RoombaBootstrapRecord record;
  memset(&record, 0, sizeof(record));
  char tokenWorkspace[65] = {};
  if (!masterAuthorization || !requestId || !configuredWorkspace ||
      !roombaMasterWorkspace(masterAuthorization, 139, tokenWorkspace) ||
      strcmp(tokenWorkspace, configuredWorkspace) != 0 ||
      !roombaValidRequestId(requestId) || requestCreatedAtMs == 0)
    return record;
  record.magic = ROOMBA_BOOTSTRAP_MAGIC;
  record.version = ROOMBA_BOOTSTRAP_VERSION;
  record.pending = ROOMBA_BOOTSTRAP_PENDING;
  memcpy(record.masterAuthorization, masterAuthorization,
         strlen(masterAuthorization));
  memcpy(record.requestId, requestId, 36);
  record.requestCreatedAtMs = requestCreatedAtMs;
  record.checksum = roombaBootstrapChecksum(record);
  return record;
}

template <typename Storage>
class RoombaBootstrapStore {
 public:
  RoombaBootstrapStore(Storage storage, size_t offset)
      : storage_(storage), offset_(offset) {}

  RoombaBootstrapState load(RoombaBootstrapRecord& out,
                            const char* configuredWorkspace) const {
    if (!fits()) return RoombaBootstrapState::NoSpace;
    RoombaBootstrapRecord record;
    storage_.readBlock(offset_, &record, sizeof(record));
    if (emptyRoombaBootstrapRecord(record)) {
      memset(&out, 0, sizeof(out));
      return RoombaBootstrapState::Empty;
    }
    if (!validRoombaBootstrapRecord(record, configuredWorkspace))
      return RoombaBootstrapState::Invalid;
    out = record;
    return RoombaBootstrapState::Pending;
  }

  bool begin(const char* masterAuthorization, const char* requestId,
             uint64_t requestCreatedAtMs, const char* configuredWorkspace) {
    RoombaBootstrapRecord previous;
    if (load(previous, configuredWorkspace) != RoombaBootstrapState::Empty)
      return false;
    RoombaBootstrapRecord record = makeRoombaBootstrapRecord(
        masterAuthorization, requestId, requestCreatedAtMs, configuredWorkspace);
    if (!validRoombaBootstrapRecord(record, configuredWorkspace)) return false;
    return writeAndVerify(record, configuredWorkspace);
  }

  bool clear() {
    if (!fits()) return false;
    RoombaBootstrapRecord empty;
    memset(&empty, 0, sizeof(empty));
    storage_.writeBlock(offset_, &empty, sizeof(empty));
    RoombaBootstrapRecord verify;
    storage_.readBlock(offset_, &verify, sizeof(verify));
    return emptyRoombaBootstrapRecord(verify);
  }

 private:
  bool fits() const {
    return offset_ <= storage_.length() &&
        sizeof(RoombaBootstrapRecord) <= storage_.length() - offset_;
  }

  bool writeAndVerify(RoombaBootstrapRecord& record,
                      const char* configuredWorkspace) {
    if (!fits()) return false;
    record.checksum = roombaBootstrapChecksum(record);
    storage_.writeBlock(offset_, &record, sizeof(record));
    RoombaBootstrapRecord verify;
    storage_.readBlock(offset_, &verify, sizeof(verify));
    return validRoombaBootstrapRecord(verify, configuredWorkspace) &&
        memcmp(&verify, &record, sizeof(record)) == 0;
  }

  Storage storage_;
  size_t offset_;
};

#endif
