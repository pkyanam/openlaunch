#ifndef OPENLAUNCH_ROOMBA_JSON_GUARD_H
#define OPENLAUNCH_ROOMBA_JSON_GUARD_H
#include <ArduinoJson.h>
#include "RoombaCommandGuard.h"
inline bool readJsonUnsignedInteger(JsonVariantConst value, uint64_t& out) {
  if (!value.is<double>()) return false;
  return parseRoombaUnsignedInteger(value.as<double>(), out);
}
#endif
