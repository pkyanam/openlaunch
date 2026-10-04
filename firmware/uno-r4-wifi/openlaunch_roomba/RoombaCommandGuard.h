#ifndef OPENLAUNCH_ROOMBA_COMMAND_GUARD_H
#define OPENLAUNCH_ROOMBA_COMMAND_GUARD_H

#include <stdint.h>

static const uint32_t ROOMBA_MOTION_RECORD_MAGIC = 0x524D4F54;
static const uint64_t ROOMBA_MAX_EXACT_JSON_INTEGER = 9007199254740991ULL;

struct RoombaMotionRecord {
  uint32_t magic;
  uint64_t lastCreatedAt;
  uint32_t checksum;
};

inline uint32_t roombaMotionChecksum(uint32_t magic, uint64_t timestamp) {
  uint32_t crc = 0xFFFFFFFF;
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&timestamp);
  for (uint8_t i = 0; i < sizeof(timestamp); ++i) {
    crc ^= bytes[i];
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xEDB88320UL & (-(int32_t)(crc & 1)));
  }
  for (uint8_t i = 0; i < 4; ++i) {
    crc ^= static_cast<uint8_t>(magic >> (i * 8));
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xEDB88320UL & (-(int32_t)(crc & 1)));
  }
  return ~crc;
}

inline RoombaMotionRecord makeRoombaMotionRecord(uint64_t timestamp) {
  RoombaMotionRecord record = {ROOMBA_MOTION_RECORD_MAGIC, timestamp,
                               roombaMotionChecksum(ROOMBA_MOTION_RECORD_MAGIC, timestamp)};
  return record;
}

inline bool validRoombaMotionRecord(const RoombaMotionRecord& record) {
  return record.magic == ROOMBA_MOTION_RECORD_MAGIC &&
         record.checksum == roombaMotionChecksum(record.magic, record.lastCreatedAt);
}

inline bool roombaTimestampIsNew(uint64_t createdAt, const RoombaMotionRecord& record) {
  return validRoombaMotionRecord(record) && createdAt > record.lastCreatedAt;
}

inline bool parseRoombaUnsignedInteger(double number, uint64_t& result) {
  if (!(number >= 0.0) || number > static_cast<double>(ROOMBA_MAX_EXACT_JSON_INTEGER) ||
      number != static_cast<double>(static_cast<uint64_t>(number))) return false;
  result = static_cast<uint64_t>(number);
  return true;
}

inline bool roombaHasExecutionBudget(uint64_t nowEpochSeconds, uint64_t expiresAt,
                                     uint16_t durationMs,
                                     uint16_t safetyMarginMs = 1000) {
  if (nowEpochSeconds < 1700000000ULL) return false;
  const uint64_t nowMs = nowEpochSeconds * 1000ULL;
  const uint64_t required = static_cast<uint64_t>(durationMs) + safetyMarginMs;
  if (nowMs > ROOMBA_MAX_EXACT_JSON_INTEGER - required) return false;
  return expiresAt > nowMs + required;
}

#endif
