#include <iostream>

#include "RoombaFunctions.h"

static void addInteger(JsonObject properties, const char* name, int min, int max) {
  JsonObject property = properties[name].to<JsonObject>();
  property["type"] = "integer";
  property["minimum"] = min;
  property["maximum"] = max;
}

int main() {
  JsonDocument doc;
  JsonObject manifest = doc.to<JsonObject>();
  manifest["name"] = "uno-r4-wifi-roomba-551";
  manifest["kind"] = "uno-r4-wifi";
  JsonArray caps = manifest["capabilities"].to<JsonArray>();
  JsonArray functions = manifest["functions"].to<JsonArray>();
  caps.add("device.health");

  JsonObject stop = functions.add<JsonObject>();
  stop["name"] = "roomba.stop";
  stop["title"] = "Stop Roomba";
  stop["description"] = "Stop the Roomba immediately.";
  stop["access"] = "write";
  JsonObject schema = stop["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  schema["properties"].to<JsonObject>();
  schema["required"].to<JsonArray>();
  schema["additionalProperties"] = false;
  caps.add("roomba.stop");

  addRoombaFeatureManifest(caps, functions);

  JsonObject drive = functions.add<JsonObject>();
  drive["name"] = "roomba.drive";
  drive["title"] = "Drive Roomba briefly";
  drive["description"] = "Run a bounded motion burst requiring local interlocks.";
  drive["access"] = "write";
  schema = drive["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  JsonArray required = schema["required"].to<JsonArray>();
  required.add("velocityMmS"); required.add("radiusMm"); required.add("durationMs");
  schema["additionalProperties"] = false;
  JsonObject props = schema["properties"].to<JsonObject>();
  addInteger(props, "velocityMmS", -150, 150);
  addInteger(props, "radiusMm", -2000, 2000);
  addInteger(props, "durationMs", 1, 1000);
  caps.add("roomba.drive");

  char output[12000];
  const size_t size = serializeJson(doc, output, sizeof(output));
  if (!size) return 1;
  std::cout.write(output, static_cast<std::streamsize>(size));
  std::cout << '\n';
  return 0;
}
