#ifndef OPENLAUNCH_ROOMBA_RESULT_JOURNAL_H
#define OPENLAUNCH_ROOMBA_RESULT_JOURNAL_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static const uint32_t ROOMBA_RESULT_JOURNAL_MAGIC = 0x524A4E4CUL;
static const size_t ROOMBA_RESULT_PAYLOAD_CAPACITY = 768;

struct RoombaPendingResult {
  uint32_t magic;
  uint8_t pending;
  char actionId[37];
  char status[10];
  uint64_t expiresAt;
  uint16_t payloadLength;
  char payload[ROOMBA_RESULT_PAYLOAD_CAPACITY + 1];
  uint32_t checksum;
};

inline uint32_t roombaResultChecksum(const RoombaPendingResult& record) {
  uint32_t crc = 0xFFFFFFFFUL;
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  for (size_t i = 0; i < offsetof(RoombaPendingResult, checksum); ++i) {
    crc ^= bytes[i];
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xEDB88320UL & (-(int32_t)(crc & 1)));
  }
  return ~crc;
}

inline bool validRoombaPendingResult(const RoombaPendingResult& record) {
  if (record.magic != ROOMBA_RESULT_JOURNAL_MAGIC ||
      record.pending != 1 || record.payloadLength == 0 ||
      record.payloadLength > ROOMBA_RESULT_PAYLOAD_CAPACITY ||
      record.actionId[36] != 0 || record.status[9] != 0 ||
      record.payload[record.payloadLength] != 0)
    return false;
  return record.checksum == roombaResultChecksum(record);
}

inline bool emptyRoombaResultJournal(const RoombaPendingResult& record) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  bool allZero = true;
  bool allErased = true;
  for (size_t i = 0; i < sizeof(record); ++i) {
    allZero = allZero && bytes[i] == 0;
    allErased = allErased && bytes[i] == 0xFF;
  }
  return allZero || allErased;
}

inline bool roombaResultResponseMatches(const RoombaPendingResult& pending,
                                        const char* actionId,
                                        const char* status,
                                        const char* expectedResult,
                                        const char* actualResult) {
  return validRoombaPendingResult(pending) && actionId && status &&
      expectedResult && actualResult &&
      strcmp(actionId, pending.actionId) == 0 &&
      strcmp(status, pending.status) == 0 &&
      strcmp(expectedResult, actualResult) == 0;
}

inline RoombaPendingResult makeRoombaPendingResult(
    const char* actionId, const char* status, uint64_t expiresAt,
    const char* payload, size_t payloadLength) {
  RoombaPendingResult record;
  memset(&record, 0, sizeof(record));
  if (!actionId || !status || !payload || strlen(actionId) != 36 ||
      strlen(status) > 9 || payloadLength == 0 ||
      payloadLength > ROOMBA_RESULT_PAYLOAD_CAPACITY ||
      strlen(payload) != payloadLength)
    return record;
  record.magic = ROOMBA_RESULT_JOURNAL_MAGIC;
  record.pending = 1;
  memcpy(record.actionId, actionId, 36);
  memcpy(record.status, status, strlen(status));
  record.expiresAt = expiresAt;
  record.payloadLength = static_cast<uint16_t>(payloadLength);
  memcpy(record.payload, payload, payloadLength);
  record.checksum = roombaResultChecksum(record);
  return record;
}

#endif
