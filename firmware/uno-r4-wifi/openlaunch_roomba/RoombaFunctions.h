#ifndef OPENLAUNCH_ROOMBA_FUNCTIONS_H
#define OPENLAUNCH_ROOMBA_FUNCTIONS_H

// Narrow, model-551-only wrappers for the pinned ArduRoomba API.  These
// functions intentionally expose bounded operations rather than raw OI
// commands, Full mode, or caller-defined song/motion sequences.
#include <ArduRoomba.h>
#include <ArduinoJson.h>
#include <string.h>

#include "RoombaDriveAdapter.h"

static const uint16_t ROOMBA_MAX_BRUSH_BURST_MS = 1000;

// Tracks a robot-native autonomous run so the sketch can observe local
// permits in its ordinary loop and enter Safe/stop if either contact opens.
class RoombaAutonomyGuard {
 public:
  void start() { active_ = true; }
  void clear() { active_ = false; }
  bool active() const { return active_; }
  bool permitLost(bool locallyArmed) const { return active_ && !locallyArmed; }
 private:
  bool active_ = false;
};

inline bool serviceRoombaAutonomyGuard(RoombaAutonomyGuard& guard,
                                       RoombaDriveIO& io,
                                       ArduRoomba& roomba) {
  if (!guard.permitLost(io.locallyArmed())) return false;
  roomba.actuators().setSafeMode();
  roomba.stop();
  roomba.actuators().stopAllMotors();
  guard.clear();
  return true;
}

inline void addIntegerProperty(JsonObject properties, const char* name,
                               int minimum, int maximum);

inline void addRoombaFeatureManifest(JsonArray capabilities, JsonArray functions) {
  capabilities.add("roomba.sensor.read");
  capabilities.add("roomba.leds.set");
  capabilities.add("roomba.tone.play");
  capabilities.add("roomba.song.play");
  capabilities.add("roomba.brushes.burst");
  capabilities.add("roomba.resume_safe");
  capabilities.add("roomba.drive_direct");
  capabilities.add("roomba.clean");
  capabilities.add("roomba.dock");
  capabilities.add("roomba.pause");

  JsonObject sensor = functions.add<JsonObject>();
  sensor["name"] = "roomba.sensor.read";
  sensor["title"] = "Read a Roomba sensor packet";
  sensor["description"] = "Read one model 551 sensor packet (IDs 16 and 32-33 are reserved and rejected). Validity only means a complete serial reply; the OI packet has no checksum.";
  sensor["access"] = "read";
  JsonObject schema = sensor["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  schema["required"].to<JsonArray>().add("packetId");
  schema["additionalProperties"] = false;
  JsonObject props = schema["properties"].to<JsonObject>();
  JsonObject packet = props["packetId"].to<JsonObject>();
  packet["type"] = "integer";
  packet["minimum"] = 7;
  packet["maximum"] = 42;

  JsonObject leds = functions.add<JsonObject>();
  leds["name"] = "roomba.leds.set";
  leds["title"] = "Set Roomba LEDs";
  leds["description"] = "Set model 551 LED bits (debris, spot, dock, check) and power LED color/intensity.";
  leds["access"] = "write";
  schema = leds["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  JsonArray required = schema["required"].to<JsonArray>();
  required.add("ledBits"); required.add("powerColor"); required.add("powerIntensity");
  schema["additionalProperties"] = false;
  props = schema["properties"].to<JsonObject>();
  addIntegerProperty(props, "ledBits", 0, 15);
  addIntegerProperty(props, "powerColor", 0, 255);
  addIntegerProperty(props, "powerIntensity", 0, 255);

  JsonObject tone = functions.add<JsonObject>();
  tone["name"] = "roomba.tone.play";
  tone["title"] = "Play a short tone";
  tone["description"] = "Play one note from the library's verified note range for at most half a second.";
  tone["access"] = "write";
  schema = tone["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  required = schema["required"].to<JsonArray>(); required.add("note"); required.add("duration");
  schema["additionalProperties"] = false;
  props = schema["properties"].to<JsonObject>();
  addIntegerProperty(props, "note", 57, 92);
  addIntegerProperty(props, "duration", 1, 32);

  JsonObject song = functions.add<JsonObject>();
  song["name"] = "roomba.song.play";
  song["title"] = "Play a built-in Roomba song";
  song["description"] = "Play one of four fixed library songs; caller-supplied sequences are not accepted.";
  song["access"] = "write";
  schema = song["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  schema["required"].to<JsonArray>().add("songId");
  schema["additionalProperties"] = false;
  props = schema["properties"].to<JsonObject>();
  JsonObject songId = props["songId"].to<JsonObject>();
  songId["type"] = "integer";
  songId["minimum"] = 0;
  songId["maximum"] = 3;

  JsonObject brushes = functions.add<JsonObject>();
  brushes["name"] = "roomba.brushes.burst";
  brushes["title"] = "Run Roomba brushes briefly";
  brushes["description"] = "Run selected brushes/vacuum while locally armed for at most one second; outputs are stopped before return.";
  brushes["access"] = "write";
  schema = brushes["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  required = schema["required"].to<JsonArray>();
  required.add("mainBrush"); required.add("sideBrush"); required.add("vacuum"); required.add("durationMs");
  schema["additionalProperties"] = false;
  props = schema["properties"].to<JsonObject>();
  props["mainBrush"]["type"] = "boolean";
  props["sideBrush"]["type"] = "boolean";
  props["vacuum"]["type"] = "boolean";
  addIntegerProperty(props, "durationMs", 1, ROOMBA_MAX_BRUSH_BURST_MS);

  JsonObject resume = functions.add<JsonObject>();
  resume["name"] = "roomba.resume_safe";
  resume["title"] = "Resume Roomba Safe mode";
  resume["description"] = "Re-enter Safe mode after docking/charging; requires both local interlocks.";
  resume["access"] = "write";
  schema = resume["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  schema["required"].to<JsonArray>();
  schema["properties"].to<JsonObject>();
  schema["additionalProperties"] = false;

  JsonObject direct = functions.add<JsonObject>();
  direct["name"] = "roomba.drive_direct";
  direct["title"] = "Drive Roomba wheels briefly";
  direct["description"] = "Run a bounded independent-wheel motion burst; stops within one second and requires local interlocks.";
  direct["access"] = "write";
  schema = direct["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  required = schema["required"].to<JsonArray>();
  required.add("rightMmS"); required.add("leftMmS"); required.add("durationMs");
  schema["additionalProperties"] = false;
  props = schema["properties"].to<JsonObject>();
  addIntegerProperty(props, "rightMmS", -150, 150);
  addIntegerProperty(props, "leftMmS", -150, 150);
  addIntegerProperty(props, "durationMs", 1, 1000);

  const char* const autonomousNames[] = {"roomba.clean", "roomba.dock", "roomba.pause"};
  const char* const autonomousTitles[] = {
    "Start autonomous cleaning", "Seek the dock", "Pause autonomous behavior"
  };
  for (size_t i = 0; i < 3; ++i) {
    JsonObject action = functions.add<JsonObject>();
    action["name"] = autonomousNames[i];
    action["title"] = autonomousTitles[i];
    action["description"] = i == 2
        ? "Enter Safe mode and stop drive and brush outputs."
        : "Start a built-in autonomous behavior; requires local enable and interlock.";
    action["access"] = "write";
    JsonObject input = action["inputSchema"].to<JsonObject>();
    input["type"] = "object";
    JsonArray required = input["required"].to<JsonArray>();
    JsonObject properties = input["properties"].to<JsonObject>();
    if (i == 0) {
      required.add("mode");
      JsonObject mode = properties["mode"].to<JsonObject>();
      mode["type"] = "string";
      mode["maxLength"] = 8;
      JsonArray choices = mode["enum"].to<JsonArray>();
      choices.add("standard"); choices.add("spot"); choices.add("max");
    }
    input["additionalProperties"] = false;
  }
}

// This helper is defined after the manifest builder to keep all exposed
// numeric bounds explicit in one place.
inline void addIntegerProperty(JsonObject properties, const char* name,
                               int minimum, int maximum) {
  JsonObject property = properties[name].to<JsonObject>();
  property["type"] = "integer";
  property["minimum"] = minimum;
  property["maximum"] = maximum;
}

inline bool exactKeys(JsonObjectConst args, const char* const* names, size_t count) {
  if (args.isNull() || args.size() != count) return false;
  for (JsonPairConst pair : args) {
    bool found = false;
    for (size_t i = 0; i < count; ++i)
      if (strcmp(pair.key().c_str(), names[i]) == 0) found = true;
    if (!found) return false;
  }
  return true;
}

inline bool integerInRange(JsonObjectConst args, const char* key,
                           int minimum, int maximum, int& value) {
  JsonVariantConst v = args[key];
  if (!v.is<int>()) return false;
  value = v.as<int>();
  return v.as<double>() == static_cast<double>(value) &&
         value >= minimum && value <= maximum;
}

inline uint8_t roombaPacketLength(uint8_t id) {
  if (id >= 7 && id <= 15) return 1;
  if (id >= 17 && id <= 18) return 1;
  if (id >= 19 && id <= 20) return 2;
  if (id == 21 || id == 24 || (id >= 34 && id <= 38)) return 1;
  if ((id >= 22 && id <= 23) || (id >= 25 && id <= 31) || (id >= 39 && id <= 42)) return 2;
  return 0;
}

// OI sensor replies contain no checksum or packet identifier. Once a timed
// out query could still have a late reply in flight, later bytes cannot be
// confidently assigned to a new request. Latch the read path closed until a
// reboot rather than present a late response as fresh data.
static bool roombaSensorLinkDesynced = false;

// Handles only the additional functions defined above. The caller retains
// ownership of common action-id, grant, expiry and result reporting logic.
// Returns false only when capability is not one of these feature functions.
inline bool handleRoombaFeature(const char* capability, JsonObjectConst args,
                               ArduRoomba& roomba, RoombaDriveIO& io,
                               JsonObject result, const char*& error) {
  error = nullptr;
  if (!capability) return false;

  const bool recognized = strcmp(capability, "roomba.sensor.read") == 0 ||
      strcmp(capability, "roomba.leds.set") == 0 ||
      strcmp(capability, "roomba.tone.play") == 0 ||
      strcmp(capability, "roomba.song.play") == 0 ||
      strcmp(capability, "roomba.brushes.burst") == 0 ||
      strcmp(capability, "roomba.resume_safe") == 0 ||
      strcmp(capability, "roomba.drive_direct") == 0 ||
      strcmp(capability, "roomba.clean") == 0 ||
      strcmp(capability, "roomba.dock") == 0 ||
      strcmp(capability, "roomba.pause") == 0;
  if (!recognized) return false;
  if (!roomba.isConnected()) {
    error = "roomba_unavailable";
    return true;
  }

  if (strcmp(capability, "roomba.sensor.read") == 0) {
    static const char* const keys[] = {"packetId"};
    int id;
    if (!exactKeys(args, keys, 1) || !integerInRange(args, "packetId", 7, 42, id) ||
        roombaPacketLength(static_cast<uint8_t>(id)) == 0) {
      error = "invalid_arguments";
      return true;
    }
    uint8_t bytes[2] = {0, 0};
    const uint8_t length = roombaPacketLength(static_cast<uint8_t>(id));
    RoombaSerial* serial = roomba.serial();
    if (roombaSensorLinkDesynced) {
      result["packetId"] = id;
      result["valid"] = false;
      result["transport"] = "serial_link_desynced";
      result["sampledAtMs"] = millis();
      result["physicalVerified"] = false;
      error = "serial_link_desynced";
      return true;
    }
    uint8_t drained = 0;
    if (serial && serial->isActive()) {
      while (serial->available() > 0 && drained < 64) {
        serial->read();
        ++drained;
      }
    }
    const bool backlog = serial && serial->available() > 0;
    const bool valid = !backlog &&
        roomba.sensors().getSensor(static_cast<uint8_t>(id), bytes, length);
    result["packetId"] = id;
    result["valid"] = valid;
    result["transport"] = valid ? "serial_response_received" :
        (backlog ? "serial_rx_backlog" : "serial_timeout");
    result["sampledAtMs"] = millis();
    if (valid) {
      JsonArray data = result["bytes"].to<JsonArray>();
      for (uint8_t i = 0; i < length; ++i) data.add(bytes[i]);
    }
    result["physicalVerified"] = false;
    if (!valid) {
      roombaSensorLinkDesynced = true;
      error = backlog ? "serial_rx_backlog" : "serial_timeout";
    }
    return true;
  }

  if (strcmp(capability, "roomba.leds.set") == 0) {
    static const char* const keys[] = {"ledBits", "powerColor", "powerIntensity"};
    int bits, color, intensity;
    if (!exactKeys(args, keys, 3) || !integerInRange(args, "ledBits", 0, 15, bits) ||
        !integerInRange(args, "powerColor", 0, 255, color) ||
        !integerInRange(args, "powerIntensity", 0, 255, intensity)) {
      error = "invalid_arguments";
      return true;
    }
    roomba.actuators().setAllLEDs(static_cast<uint8_t>(bits),
        static_cast<uint8_t>(color), static_cast<uint8_t>(intensity));
    result["accepted"] = true;
    result["transport"] = "serial_command_sent";
    result["physicalVerified"] = false;
    return true;
  }

  if (strcmp(capability, "roomba.tone.play") == 0) {
    static const char* const keys[] = {"note", "duration"};
    int note, duration;
    if (!exactKeys(args, keys, 2) || !integerInRange(args, "note", 57, 92, note) ||
        !integerInRange(args, "duration", 1, 32, duration)) {
      error = "invalid_arguments";
      return true;
    }
    roomba.actuators().playTone(static_cast<uint8_t>(note), static_cast<uint8_t>(duration));
    result["accepted"] = true;
    result["transport"] = "serial_command_sent";
    result["physicalVerified"] = false;
    return true;
  }

  if (strcmp(capability, "roomba.song.play") == 0) {
    static const char* const keys[] = {"songId"};
    int song;
    if (!exactKeys(args, keys, 1) || !integerInRange(args, "songId", 0, 3, song)) {
      error = "invalid_arguments";
      return true;
    }
    // playTone overwrites slot 0; restore fixed definitions before every song.
    roomba.actuators().definePredefinedSongs();
    switch (song) {
      case 0: roomba.actuators().playStartupSong(); break;
      case 1: roomba.actuators().playHappySong(); break;
      case 2: roomba.actuators().playSadSong(); break;
      default: roomba.actuators().playAlertSong(); break;
    }
    result["accepted"] = true;
    result["transport"] = "serial_command_sent";
    result["physicalVerified"] = false;
    return true;
  }

  if (strcmp(capability, "roomba.brushes.burst") == 0) {
    static const char* const keys[] = {"mainBrush", "sideBrush", "vacuum", "durationMs"};
    int duration;
    if (!exactKeys(args, keys, 4) || !args["mainBrush"].is<bool>() ||
        !args["sideBrush"].is<bool>() || !args["vacuum"].is<bool>() ||
        !integerInRange(args, "durationMs", 1, ROOMBA_MAX_BRUSH_BURST_MS, duration)) {
      error = "invalid_arguments";
      return true;
    }
    if (!io.locallyArmed()) {
      roomba.stop(); roomba.actuators().stopAllMotors();
      error = "local_interlock_open";
      return true;
    }
    const uint32_t startedAt = io.nowMs();
    roomba.actuators().setMotors(args["mainBrush"].as<bool>(),
        args["sideBrush"].as<bool>(), args["vacuum"].as<bool>());
    while (static_cast<uint32_t>(io.nowMs() - startedAt) < static_cast<uint32_t>(duration)) {
      if (!io.locallyArmed()) {
        roomba.stop(); roomba.actuators().stopAllMotors();
        error = "local_interlock_open";
        return true;
      }
    }
    roomba.stop();
    roomba.actuators().stopAllMotors();
    result["accepted"] = true;
    result["transport"] = "serial_command_sent";
    result["physicalVerified"] = false;
    return true;
  }

  if (strcmp(capability, "roomba.resume_safe") == 0) {
    if (!exactKeys(args, nullptr, 0)) {
      error = "invalid_arguments";
      return true;
    }
    if (!io.locallyArmed()) {
      roomba.stop(); roomba.actuators().stopAllMotors();
      error = "local_interlock_open";
      return true;
    }
    const bool resumed = roomba.resumeControl();
    roomba.stop();
    roomba.actuators().stopAllMotors();
    if (!resumed) {
      error = "resume_failed";
      return true;
    }
    result["accepted"] = true;
    result["transport"] = "serial_command_sent";
    result["physicalVerified"] = false;
    return true;
  }

  if (strcmp(capability, "roomba.drive_direct") == 0) {
    static const char* const keys[] = {"rightMmS", "leftMmS", "durationMs"};
    int right, left, duration;
    if (!exactKeys(args, keys, 3) || !integerInRange(args, "rightMmS", -150, 150, right) ||
        !integerInRange(args, "leftMmS", -150, 150, left) ||
        !integerInRange(args, "durationMs", 1, 1000, duration)) {
      error = "invalid_arguments";
      return true;
    }
    if (!io.locallyArmed()) {
      roomba.stop(); roomba.actuators().stopAllMotors();
      error = "local_interlock_open";
      return true;
    }
    const uint32_t startedAt = io.nowMs();
    roomba.movement().driveDirect(static_cast<int16_t>(right), static_cast<int16_t>(left));
    while (static_cast<uint32_t>(io.nowMs() - startedAt) < static_cast<uint32_t>(duration)) {
      if (!io.locallyArmed()) {
        roomba.stop(); roomba.actuators().stopAllMotors();
        error = "local_interlock_open";
        return true;
      }
    }
    roomba.stop();
    roomba.actuators().stopAllMotors();
    result["accepted"] = true;
    result["transport"] = "serial_command_sent";
    result["physicalVerified"] = false;
    return true;
  }

  // Cleaning and docking use the robot's own autonomous routines, which move
  // to Passive mode and continue after this network action completes. OI has
  // no resumable pause opcode: pause enters Safe mode, then sends stop outputs.
  if (strcmp(capability, "roomba.clean") == 0 ||
      strcmp(capability, "roomba.dock") == 0 ||
      strcmp(capability, "roomba.pause") == 0) {
    const bool isClean = strcmp(capability, "roomba.clean") == 0;
    const bool isDock = strcmp(capability, "roomba.dock") == 0;
    static const char* const cleanKeys[] = {"mode"};
    if ((isClean && !exactKeys(args, cleanKeys, 1)) ||
        (!isClean && !exactKeys(args, nullptr, 0))) {
      error = "invalid_arguments";
      return true;
    }
    if (!isClean && !isDock) {
      roomba.actuators().setSafeMode();
      roomba.stop();
      roomba.actuators().stopAllMotors();
      result["accepted"] = true;
      result["transport"] = "serial_command_sent";
      result["behavior"] = "safe_mode_stop";
      result["physicalVerified"] = false;
      return true;
    }
    if (!io.locallyArmed()) {
      roomba.stop(); roomba.actuators().stopAllMotors();
      error = "local_interlock_open";
      return true;
    }
    if (isDock) {
      roomba.actuators().seekDock();
    } else {
      JsonVariantConst mode = args["mode"];
      if (!mode.is<const char*>()) {
        error = "invalid_arguments";
        return true;
      }
      const char* value = mode.as<const char*>();
      if (strcmp(value, "standard") == 0) roomba.actuators().startCleaning();
      else if (strcmp(value, "spot") == 0) roomba.actuators().startSpotClean();
      else if (strcmp(value, "max") == 0) roomba.actuators().startMaxClean();
      else {
        error = "invalid_arguments";
        return true;
      }
    }
    result["accepted"] = true;
    result["transport"] = "serial_command_sent";
    result["behavior"] = "robot_autonomous";
    result["physicalVerified"] = false;
    return true;
  }

  return false;
}

#endif
