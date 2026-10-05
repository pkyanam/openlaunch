#include <assert.h>
#include <string.h>

#include "RoombaFunctions.h"
#include "RoombaJsonGuard.h"

class TestIO : public RoombaDriveIO {
 public:
  uint32_t now = 0;
  uint32_t disarmAt = 0;
  bool armed = true;
  uint32_t nowMs() override { return now++; }
  bool locallyArmed() override { return armed && (!disarmAt || now < disarmAt); }
  void drive(int16_t, int16_t) override {}
  void stop() override {}
};

static JsonObjectConst argsWith(JsonDocument& doc, const char* key, int value) {
  JsonObject args = doc.to<JsonObject>();
  args[key] = value;
  return args;
}

int main() {
  assert(roombaPacketLength(7) == 1);
  assert(roombaPacketLength(15) == 1);
  assert(roombaPacketLength(16) == 0);
  assert(roombaPacketLength(17) == 1);
  assert(roombaPacketLength(19) == 2);
  assert(roombaPacketLength(27) == 2);
  assert(roombaPacketLength(32) == 0);
  assert(roombaPacketLength(34) == 1);
  assert(roombaPacketLength(42) == 2);
  assert(roombaPacketLength(43) == 0);

  ArduRoomba roomba;
  TestIO io;
  RoombaLocalControl serialOnly(ROOMBA_REQUIRE_LOCAL_CONTACTS);
  io.armed = serialOnly.allows(true, false, false);
  assert(io.armed); // Default harness has neither D6 nor D7 connected.
  const char* error = nullptr;

  JsonDocument argsDoc, resultDoc;
  JsonObjectConst args = argsWith(argsDoc, "packetId", 42);
  roomba.serialPort.pending = 512; // Startup text exceeded the old 64-byte cap.
  bool handled = handleRoombaFeature("roomba.sensor.read", args, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && error == nullptr);
  assert(roomba.sensorInterface.requestedId == 42);
  assert(roomba.sensorInterface.requestedLength == 2);
  assert(resultDoc["valid"] == true);
  assert(resultDoc["bytes"][0] == 1 && resultDoc["bytes"][1] == 2);
  assert(resultDoc["discardedRxBytes"] == 512);

  // Continuous noise is bounded, sends no query, and can recover once quiet.
  argsDoc.clear(); resultDoc.clear();
  args = argsWith(argsDoc, "packetId", 35);
  roomba.serialPort.continuous = true;
  const int queriesBeforeBacklog = roomba.sensorInterface.queries;
  handled = handleRoombaFeature("roomba.sensor.read", args, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && strcmp(error, "serial_rx_backlog") == 0);
  assert(roomba.sensorInterface.queries == queriesBeforeBacklog);
  assert(!roombaSensorLinkDesynced);
  roomba.serialPort.continuous = false;
  argsDoc.clear(); resultDoc.clear();
  args = argsWith(argsDoc, "packetId", 35);
  handled = handleRoombaFeature("roomba.sensor.read", args, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && error == nullptr && resultDoc["valid"] == true);

  argsDoc.clear(); resultDoc.clear();
  roomba.sensorInterface.reply = false;
  args = argsWith(argsDoc, "packetId", 22);
  handled = handleRoombaFeature("roomba.sensor.read", args, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && strcmp(error, "serial_timeout") == 0);
  assert(resultDoc["valid"] == false);
  assert(resultDoc["transport"] == "serial_timeout");
  assert(resultDoc["sampledAtMs"].as<unsigned long>() >= 1234);
  assert(roombaSensorLinkDesynced);
  const int queriesBeforeRetry = roomba.sensorInterface.queries;
  roomba.sensorInterface.reply = true;
  argsDoc.clear(); resultDoc.clear();
  args = argsWith(argsDoc, "packetId", 35);
  handled = handleRoombaFeature("roomba.sensor.read", args, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && strcmp(error, "serial_link_desynced") == 0);
  assert(roomba.sensorInterface.queries == queriesBeforeRetry);

  argsDoc.clear(); resultDoc.clear();
  roomba.sensorInterface.reply = true;
  args = argsWith(argsDoc, "packetId", 16);
  handled = handleRoombaFeature("roomba.sensor.read", args, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && strcmp(error, "invalid_arguments") == 0);

  argsDoc.clear(); resultDoc.clear();
  JsonObject brushArgs = argsDoc.to<JsonObject>();
  brushArgs["mainBrush"] = true;
  brushArgs["sideBrush"] = false;
  brushArgs["vacuum"] = true;
  brushArgs["durationMs"] = 5;
  io.armed = true; io.disarmAt = io.now + 2;
  handled = handleRoombaFeature("roomba.brushes.burst", brushArgs, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && strcmp(error, "local_interlock_open") == 0);
  assert(!roomba.actuatorInterface.mainBrush && !roomba.actuatorInterface.vacuum);
  assert(roomba.stopCount > 0 && roomba.actuatorInterface.stopCount > 0);

  argsDoc.clear(); resultDoc.clear();
  JsonObject ledArgs = argsDoc.to<JsonObject>();
  ledArgs["ledBits"] = 16;
  ledArgs["powerColor"] = 0;
  ledArgs["powerIntensity"] = 255;
  handled = handleRoombaFeature("roomba.leds.set", ledArgs, roomba, io,
      resultDoc.to<JsonObject>(), error);
  assert(handled && strcmp(error, "invalid_arguments") == 0);

  argsDoc.clear(); resultDoc.clear();
  JsonObject tone = argsDoc.to<JsonObject>(); tone["note"] = 72; tone["duration"] = 16;
  assert(handleRoombaFeature("roomba.tone.play", tone, roomba, io, resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.actuatorInterface.slotZeroIsTone);
  argsDoc.clear(); resultDoc.clear();
  args = argsWith(argsDoc, "songId", 0);
  assert(handleRoombaFeature("roomba.song.play", args, roomba, io, resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.actuatorInterface.defineCount == 1);
  assert(!roomba.actuatorInterface.playedToneAsSong);

  io.armed = serialOnly.allows(true, false, false); io.disarmAt = 0;
  argsDoc.clear(); resultDoc.clear();
  JsonObject clean = argsDoc.to<JsonObject>(); clean["mode"] = "standard";
  assert(handleRoombaFeature("roomba.clean", clean, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.actuatorInterface.cleanCount == 1);
  assert(resultDoc["transport"] == "serial_command_sent");
  assert(resultDoc["behavior"] == "robot_autonomous");
  assert(resultDoc["physicalVerified"] == false);

  argsDoc.clear(); resultDoc.clear();
  clean = argsDoc.to<JsonObject>(); clean["mode"] = "spot";
  assert(handleRoombaFeature("roomba.clean", clean, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.actuatorInterface.spotCount == 1);
  argsDoc.clear(); resultDoc.clear();
  clean = argsDoc.to<JsonObject>(); clean["mode"] = "max";
  assert(handleRoombaFeature("roomba.clean", clean, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.actuatorInterface.maxCount == 1);

  argsDoc.clear(); resultDoc.clear();
  JsonObject dock = argsDoc.to<JsonObject>();
  assert(handleRoombaFeature("roomba.dock", dock, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.actuatorInterface.dockCount == 1);

  // The standard serial-only harness supports recovery and bounded manual
  // outputs too, without pretending that unconnected D6/D7 contacts are armed.
  io.armed = serialOnly.allows(true, false, false);
  argsDoc.clear(); resultDoc.clear();
  JsonObject recovery = argsDoc.to<JsonObject>();
  assert(handleRoombaFeature("roomba.resume_safe", recovery, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.resumeCount == 1);
  argsDoc.clear(); resultDoc.clear();
  JsonObject wheels = argsDoc.to<JsonObject>();
  wheels["rightMmS"] = 100; wheels["leftMmS"] = 100; wheels["durationMs"] = 1000;
  const int stoppedBeforeWheels = roomba.stopCount;
  assert(handleRoombaFeature("roomba.drive_direct", wheels, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.movementInterface.directCount == 1);
  assert(roomba.stopCount == stoppedBeforeWheels + 1);
  argsDoc.clear(); resultDoc.clear();
  brushArgs = argsDoc.to<JsonObject>();
  brushArgs["mainBrush"] = true; brushArgs["sideBrush"] = true;
  brushArgs["vacuum"] = true; brushArgs["durationMs"] = 1000;
  assert(handleRoombaFeature("roomba.brushes.burst", brushArgs, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && !roomba.actuatorInterface.mainBrush &&
      !roomba.actuatorInterface.sideBrush && !roomba.actuatorInterface.vacuum);

  // Pause exits autonomous Passive mode to Safe before stopping drive/brushes.
  argsDoc.clear(); resultDoc.clear();
  JsonObject pause = argsDoc.to<JsonObject>();
  io.armed = false;
  const int stoppedBeforePause = roomba.stopCount;
  assert(handleRoombaFeature("roomba.pause", pause, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(error == nullptr && roomba.actuatorInterface.safeModeCount == 1);
  assert(roomba.stopCount == stoppedBeforePause + 1);
  assert(resultDoc["behavior"] == "safe_mode_stop");

  // A lost local permit ends a tracked autonomous run at the next loop check.
  RoombaAutonomyGuard autonomy;
  autonomy.start();
  io.armed = false;
  roomba.actuatorInterface.setMotors(true, true, true);
  const int safeBeforePermitLoss = roomba.actuatorInterface.safeModeCount;
  const int stopBeforePermitLoss = roomba.stopCount;
  assert(serviceRoombaAutonomyGuard(autonomy, io, roomba));
  assert(!autonomy.active());
  assert(roomba.actuatorInterface.safeModeCount == safeBeforePermitLoss + 1);
  assert(roomba.stopCount == stopBeforePermitLoss + 1);
  assert(!roomba.actuatorInterface.mainBrush && !roomba.actuatorInterface.sideBrush &&
         !roomba.actuatorInterface.vacuum);
  assert(!serviceRoombaAutonomyGuard(autonomy, io, roomba));

  io.armed = true;
  argsDoc.clear(); resultDoc.clear();
  clean = argsDoc.to<JsonObject>(); clean["mode"] = "full";
  const int cleanBeforeInvalid = roomba.actuatorInterface.cleanCount;
  assert(handleRoombaFeature("roomba.clean", clean, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(strcmp(error, "invalid_arguments") == 0);
  assert(roomba.actuatorInterface.cleanCount == cleanBeforeInvalid);

  io.armed = false; argsDoc.clear(); resultDoc.clear();
  clean = argsDoc.to<JsonObject>(); clean["mode"] = "standard";
  const int cleanBeforeUnarmed = roomba.actuatorInterface.cleanCount;
  assert(handleRoombaFeature("roomba.clean", clean, roomba, io,
      resultDoc.to<JsonObject>(), error));
  assert(strcmp(error, "local_interlock_open") == 0);
  assert(roomba.actuatorInterface.cleanCount == cleanBeforeUnarmed);

  JsonDocument envelope;
  assert(!deserializeJson(envelope, "{\"createdAt\":1791150000000,\"fraction\":1.5,\"negative\":-1,\"string\":\"1791150000000\",\"tooLarge\":9007199254740992}"));
  uint64_t timestamp = 0;
  assert(readJsonUnsignedInteger(envelope["createdAt"], timestamp));
  assert(timestamp == 1791150000000ULL);
  assert(!readJsonUnsignedInteger(envelope["fraction"], timestamp));
  assert(!readJsonUnsignedInteger(envelope["negative"], timestamp));
  assert(!readJsonUnsignedInteger(envelope["string"], timestamp));
  assert(!readJsonUnsignedInteger(envelope["tooLarge"], timestamp));
  assert(!readJsonUnsignedInteger(envelope["missing"], timestamp));
  return 0;
}
