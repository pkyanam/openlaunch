#ifndef OPENLAUNCH_ROOMBA_JSON_GUARD_H
#define OPENLAUNCH_ROOMBA_JSON_GUARD_H
#include <ArduinoJson.h>
#include "RoombaCommandGuard.h"
inline bool readJsonUnsignedInteger(JsonVariantConst value, uint64_t& out) {
  if (!value.is<double>()) return false;
  return parseRoombaUnsignedInteger(value.as<double>(), out);
}
// Object order is not part of JSON equality. Preserve scalar types and array
// order so a reordered service receipt can acknowledge the exact outcome.
inline bool roombaResultJsonEqual(JsonVariantConst expected, JsonVariantConst actual) {
  if (expected.isUnbound() || actual.isUnbound()) return false;
  if (expected.is<JsonObjectConst>()) {
    if (!actual.is<JsonObjectConst>() || expected.size() != actual.size()) return false;
    for (JsonPairConst pair : expected.as<JsonObjectConst>())
      if (!roombaResultJsonEqual(pair.value(), actual[pair.key().c_str()])) return false;
    return true;
  }
  if (expected.is<JsonArrayConst>()) {
    if (!actual.is<JsonArrayConst>() || expected.size() != actual.size()) return false;
    for (size_t i = 0; i < expected.size(); ++i)
      if (!roombaResultJsonEqual(expected[i], actual[i])) return false;
    return true;
  }
  if (expected.is<bool>()) return actual.is<bool>() && expected == actual;
  if (expected.is<const char*>()) return actual.is<const char*>() && expected == actual;
  if (expected.is<double>()) return actual.is<double>() && expected == actual;
  return expected.isNull() && actual.isNull();
}
#endif
