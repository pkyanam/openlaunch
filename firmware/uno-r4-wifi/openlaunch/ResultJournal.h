#ifndef OPENLAUNCH_UNO_RESULT_JOURNAL_H
#define OPENLAUNCH_UNO_RESULT_JOURNAL_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static const uint32_t OPENLAUNCH_RESULT_JOURNAL_MAGIC = 0x554A4E31UL;
static const size_t OPENLAUNCH_RESULT_CAPACITY = 1024;
static const uint8_t OPENLAUNCH_RESULT_INTENT = 1;
static const uint8_t OPENLAUNCH_RESULT_SAVED = 2;
static const uint8_t OPENLAUNCH_RESULT_HALTED = 3;

struct OpenLaunchResultRecord {
  uint32_t magic;
  uint8_t state;
  char actionId[37];
  uint64_t expiresAt;
  uint16_t payloadLength;
  char payload[OPENLAUNCH_RESULT_CAPACITY + 1];
  uint32_t checksum;
};

enum class OpenLaunchJournalState : uint8_t {
  Empty,
  Intent,
  Saved,
  Halted,
  Invalid,
  NoSpace
};

inline uint32_t openLaunchResultChecksum(const OpenLaunchResultRecord& record) {
  uint32_t crc = 0xFFFFFFFFUL;
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  for (size_t i = 0; i < offsetof(OpenLaunchResultRecord, checksum); ++i) {
    crc ^= bytes[i];
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xEDB88320UL & (-(int32_t)(crc & 1)));
  }
  return ~crc;
}

inline bool openLaunchRecordEmpty(const OpenLaunchResultRecord& record) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  bool zero = true;
  bool erased = true;
  for (size_t i = 0; i < sizeof(record); ++i) {
    zero = zero && bytes[i] == 0;
    erased = erased && bytes[i] == 0xFF;
  }
  return zero || erased;
}

inline bool openLaunchValidActionId(const char* id, size_t capacity = 37) {
  if (!id || capacity < 37) return false;
  const char* terminator = static_cast<const char*>(memchr(id, '\0', capacity));
  if (!terminator || static_cast<size_t>(terminator - id) != 36) return false;
  for (size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') return false;
    } else if (!((id[i] >= '0' && id[i] <= '9') ||
                 (id[i] >= 'a' && id[i] <= 'f'))) return false;
  }
  return true;
}

inline bool openLaunchValidResultRecord(const OpenLaunchResultRecord& record) {
  if (record.magic != OPENLAUNCH_RESULT_JOURNAL_MAGIC ||
      (record.state != OPENLAUNCH_RESULT_INTENT &&
       record.state != OPENLAUNCH_RESULT_SAVED &&
       record.state != OPENLAUNCH_RESULT_HALTED) ||
      !openLaunchValidActionId(record.actionId) || record.expiresAt == 0 ||
      record.payloadLength > OPENLAUNCH_RESULT_CAPACITY ||
      record.payload[record.payloadLength] != '\0')
    return false;
  if (record.state == OPENLAUNCH_RESULT_INTENT && record.payloadLength != 0)
    return false;
  if (record.state != OPENLAUNCH_RESULT_INTENT && record.payloadLength == 0)
    return false;
  return record.checksum == openLaunchResultChecksum(record);
}

template <typename Storage>
class OpenLaunchResultJournal {
 public:
  OpenLaunchResultJournal(Storage storage, size_t offset)
      : storage_(storage), offset_(offset) {}

  bool fits() const {
    return offset_ <= storage_.length() &&
        sizeof(OpenLaunchResultRecord) <= storage_.length() - offset_;
  }

  OpenLaunchJournalState load(OpenLaunchResultRecord& out) const {
    if (!fits()) return OpenLaunchJournalState::NoSpace;
    OpenLaunchResultRecord record;
    storage_.readBlock(offset_, &record, sizeof(record));
    if (openLaunchRecordEmpty(record)) {
      memset(&out, 0, sizeof(out));
      return OpenLaunchJournalState::Empty;
    }
    if (!openLaunchValidResultRecord(record)) return OpenLaunchJournalState::Invalid;
    out = record;
    if (record.state == OPENLAUNCH_RESULT_INTENT) return OpenLaunchJournalState::Intent;
    return record.state == OPENLAUNCH_RESULT_HALTED
        ? OpenLaunchJournalState::Halted : OpenLaunchJournalState::Saved;
  }

  bool begin(const char* actionId, uint64_t expiresAt) {
    if (!openLaunchValidActionId(actionId) || expiresAt == 0) return false;
    OpenLaunchResultRecord existing;
    if (load(existing) != OpenLaunchJournalState::Empty) return false;
    OpenLaunchResultRecord record;
    memset(&record, 0, sizeof(record));
    record.magic = OPENLAUNCH_RESULT_JOURNAL_MAGIC;
    record.state = OPENLAUNCH_RESULT_INTENT;
    memcpy(record.actionId, actionId, 36);
    record.expiresAt = expiresAt;
    return writeAndVerify(record);
  }

  bool saveOutcome(const char* actionId, uint64_t expiresAt,
                   const char* payload, size_t payloadLength) {
    if (!payload || payloadLength == 0 ||
        payloadLength > OPENLAUNCH_RESULT_CAPACITY ||
        strlen(payload) != payloadLength) return false;
    OpenLaunchResultRecord current;
    if (load(current) != OpenLaunchJournalState::Intent ||
        strcmp(current.actionId, actionId ? actionId : "") != 0 ||
        current.expiresAt != expiresAt)
      return false;
    current.state = OPENLAUNCH_RESULT_SAVED;
    current.payloadLength = static_cast<uint16_t>(payloadLength);
    memcpy(current.payload, payload, payloadLength);
    current.payload[payloadLength] = '\0';
    current.checksum = openLaunchResultChecksum(current);
    return writeAndVerify(current);
  }

  bool clearMatching(const char* actionId, const char* payload,
                     size_t payloadLength) {
    OpenLaunchResultRecord current;
    if (load(current) != OpenLaunchJournalState::Saved || !actionId || !payload ||
        strcmp(current.actionId, actionId) != 0 ||
        current.payloadLength != payloadLength ||
        memcmp(current.payload, payload, payloadLength) != 0)
      return false;
    OpenLaunchResultRecord empty;
    memset(&empty, 0, sizeof(empty));
    storage_.writeBlock(offset_, &empty, sizeof(empty));
    OpenLaunchResultRecord verify;
    storage_.readBlock(offset_, &verify, sizeof(verify));
    return openLaunchRecordEmpty(verify);
  }

  bool halt(const char* actionId) {
    OpenLaunchResultRecord current;
    if (load(current) != OpenLaunchJournalState::Saved || !actionId ||
        strcmp(current.actionId, actionId) != 0)
      return false;
    current.state = OPENLAUNCH_RESULT_HALTED;
    current.checksum = openLaunchResultChecksum(current);
    return writeAndVerify(current);
  }

 private:
  bool writeAndVerify(OpenLaunchResultRecord& record) {
    if (!fits()) return false;
    record.checksum = openLaunchResultChecksum(record);
    storage_.writeBlock(offset_, &record, sizeof(record));
    OpenLaunchResultRecord verify;
    storage_.readBlock(offset_, &verify, sizeof(verify));
    return openLaunchValidResultRecord(verify) &&
        memcmp(&verify, &record, sizeof(record)) == 0;
  }

  Storage storage_;
  size_t offset_;
};

inline bool openLaunchResultExpired(const OpenLaunchResultRecord& record,
                                    uint64_t nowMs) {
  return openLaunchValidResultRecord(record) && nowMs >= record.expiresAt;
}

#endif
