/*
 * openlaunch Roomba 551 adapter for Uno R4 WiFi.
 *
 * Provision model "551" only after checking the physical label. On the
 * Roomba connector, pin 4 TX goes to Uno R4 D0/Serial1 RX, pin 3 RX to D1/TX,
 * pin 5 BRC to D5, and pin 6 or 7 ground to Uno ground. The board supply may
 * use the robot's Vout on VIN; never connect battery output to the 5V pin.
 * The default needs no D6/D7 contacts. An owner-selected contact build
 * requires D6 release then close and D7 closed to ground; open wires disarm.
 * Roomba drive commands persist until stopped, so every remote drive is a
 * locally timed burst of at most one second. No WiFi, HTTP, or clock calls
 * run while a burst is active.
 *
 * Credentials are provisioned over USB and stored in EEPROM, which is not
 * tamper-resistant. Never print or commit credentials. TLS verification is
 * required.
 */
#include <WiFiS3.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <EEPROM.h>
#include <ArduRoomba.h>
#include <stddef.h>
#include "RoombaDriveAdapter.h"
#include "RoombaCommandGuard.h"
#include "RoombaJsonGuard.h"
#include "RoombaResultJournal.h"
#include "RoombaBootstrapRecord.h"
#include "RoombaFunctions.h"

// Optional contact builds use separate switches so LOW means permitted.
static const uint8_t LOCAL_ENABLE_PIN = 6;
static const uint8_t ESTOP_OK_PIN = 7;
static const uint8_t ROOMBA_BRC_PIN = 5;
static const uint32_t LEGACY_CONFIG_MAGIC = 0x4F4C5231;
static const uint32_t CONFIG_MAGIC = 0x4F4C5232;
static const uint32_t CONFIG_VERSION = 2;
static const int EEPROM_MOTION_OFFSET = 512;
static const int EEPROM_RESULT_OFFSET = 544;
static const uint32_t POLL_INTERVAL_MS = 1000;

struct LegacyConfig {
  uint32_t magic;
  char model[16], ssid[33], password[65], host[128], workspace[65], deviceId[37], token[65];
};

struct Config {
  uint32_t magic;
  char model[16], ssid[33], password[65], host[128], workspace[65], deviceId[37], token[65];
  uint32_t version;
  uint32_t crc;
} cfg;
static_assert(offsetof(Config, magic) == offsetof(LegacyConfig, magic), "legacy config magic moved");
static_assert(offsetof(Config, model) == offsetof(LegacyConfig, model), "legacy config model moved");
static_assert(offsetof(Config, token) == offsetof(LegacyConfig, token), "legacy config token moved");
static_assert(sizeof(Config) <= EEPROM_MOTION_OFFSET, "Roomba config overlaps motion journal");

static const int EEPROM_BOOTSTRAP_OFFSET =
    (EEPROM_RESULT_OFFSET + sizeof(RoombaPendingResult) + 3) & ~3;
RoombaMotionRecord motionRecord;
bool motionReady = false;
bool roombaReady = false;
RoombaLocalControl localControl(ROOMBA_REQUIRE_LOCAL_CONTACTS);
RoombaAutonomyGuard autonomyGuard;
RoombaPendingResult pendingResult = {};
RoombaBootstrapRecord bootstrapRecord = {};
RoombaBootstrapState bootstrapState = RoombaBootstrapState::Empty;
bool resultJournalReady = false;
bool resultJournalFault = false;
bool resultAuthRevoked = false;
bool resultExpiryReported = false;
uint32_t nextResultAttemptMs = 0;
uint32_t resultRetryDelayMs = 1000;
uint32_t attachRetryAtMs = 0;
uint32_t attachRetryDelayMs = 5000;
bool attachRetryScheduled = false;
bool attachStopped = false;
bool attachExpiredReported = false;
bool manifestPublished = false;
bool manifestPublishStopped = false;
unsigned long nextManifestPublishMs = 0;
unsigned long manifestPublishDelayMs = 5000;
unsigned long lastWifiAttempt = 0;
uint64_t activeActionExpiresAt = 0;
bool configStorageFault = false;
int lastAttachHttpStatus = 0;
char lastAttachErrorCode[48] = {};
char lastAttachDiagnostic[112] = {};

struct EepromBootstrapStorage {
  size_t length() const { return EEPROM.length(); }
  void readBlock(size_t offset, void* destination, size_t length) const {
    uint8_t* bytes = static_cast<uint8_t*>(destination);
    for (size_t i = 0; i < length; ++i)
      bytes[i] = EEPROM.read(static_cast<int>(offset + i));
  }
  void writeBlock(size_t offset, const void* source, size_t length) const {
    if (length == sizeof(RoombaBootstrapRecord)) {
      EEPROM.put(static_cast<int>(offset),
          *static_cast<const RoombaBootstrapRecord*>(source));
      return;
    }
    const uint8_t* bytes = static_cast<const uint8_t*>(source);
    for (size_t i = 0; i < length; ++i)
      EEPROM.update(static_cast<int>(offset + i), bytes[i]);
  }
};
RoombaBootstrapStore<EepromBootstrapStorage> bootstrapStore(
    EepromBootstrapStorage{}, EEPROM_BOOTSTRAP_OFFSET);

bool writeMotionRecord(uint64_t timestamp) {
  RoombaMotionRecord next = makeRoombaMotionRecord(timestamp);
  EEPROM.put(EEPROM_MOTION_OFFSET, next);
  RoombaMotionRecord check;
  EEPROM.get(EEPROM_MOTION_OFFSET, check);
  if (check.magic != next.magic || check.lastCreatedAt != timestamp ||
      check.checksum != next.checksum || !validRoombaMotionRecord(check)) {
    motionReady = false;
    return false;
  }
  motionRecord = check;
  motionReady = true;
  return true;
}


RoombaConfig makeRoombaConfig() {
  RoombaConfig config = RoombaConfig::createUnoR4(ROOMBA_BRC_PIN);
  config.baudRate = 19200; // Owner-reported setting; physical operation is unverified.
  return config;
}
ArduRoomba roomba(makeRoombaConfig());

class BoardDriveIO : public RoombaDriveIO {
 public:
  uint32_t nowMs() override { return millis(); }
  bool locallyArmed() override {
    const bool ready = roombaReady && motionReady && resultJournalReady &&
        !configStorageFault && !resultJournalFault && !resultAuthRevoked &&
        cfg.magic == CONFIG_MAGIC && strcmp(cfg.model, "551") == 0;
    return localControl.allows(ready,
        ROOMBA_REQUIRE_LOCAL_CONTACTS && digitalRead(LOCAL_ENABLE_PIN) == LOW,
        ROOMBA_REQUIRE_LOCAL_CONTACTS && digitalRead(ESTOP_OK_PIN) == LOW);
  }
  void drive(int16_t velocityMmS, int16_t radiusMm) override {
    if (!roombaReady) return;
    if (autonomyGuard.active()) {
      roomba.actuators().setSafeMode();
      autonomyGuard.clear();
      roomba.stop();
      roomba.actuators().stopAllMotors();
    }
    roomba.movement().drive(velocityMmS, radiusMm);
  }
  void stop() override {
    if (!roombaReady) return;
    if (autonomyGuard.active()) {
      roomba.actuators().setSafeMode();
      autonomyGuard.clear();
    }
    roomba.stop();
    roomba.actuators().stopAllMotors();
  }
};

BoardDriveIO driveIO;
RoombaDriveAdapter driveAdapter(driveIO);
char lastAction[37] = {0};
unsigned long lastPoll = 0;

bool safeCopy(char* dst, size_t n, JsonVariantConst src) {
  const char* s = src.as<const char*>();
  if (!s || strlen(s) >= n) return false;
  strcpy(dst, s);
  return true;
}

void addMovementManifest(JsonArray functions);
void addRoombaManifest(JsonDocument& request);
bool publishPairedManifest();

bool safeString(const char* value, size_t capacity) {
  return value && memchr(value, '\0', capacity) != nullptr;
}

bool isUuid(const char* value);

uint32_t configChecksum(const Config& value) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&value);
  uint32_t crc = 0xFFFFFFFFUL;
  for (size_t i = 0; i < offsetof(Config, crc); ++i) {
    crc ^= bytes[i];
    for (uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xEDB88320UL & (-(int32_t)(crc & 1)));
  }
  return ~crc;
}

bool validLowerHex(const char* value, size_t length) {
  for (size_t i = 0; i < length; ++i)
    if (!((value[i] >= '0' && value[i] <= '9') ||
          (value[i] >= 'a' && value[i] <= 'f'))) return false;
  return value[length] == '\0';
}

bool validHost(const char* host) {
  if (!safeString(host, sizeof(cfg.host)) || !host[0]) return false;
  for (size_t i = 0; host[i]; ++i)
    if (!(isalnum(static_cast<unsigned char>(host[i])) ||
          host[i] == '.' || host[i] == '-')) return false;
  return true;
}

bool validConfig(const Config& value) {
  if (value.magic != CONFIG_MAGIC || value.version != CONFIG_VERSION ||
      value.crc != configChecksum(value) || value.model[sizeof(value.model) - 1] != '\0' ||
      !safeString(value.model, sizeof(value.model)) || strcmp(value.model, "551") != 0 ||
      !safeString(value.ssid, sizeof(value.ssid)) || !value.ssid[0] ||
      !safeString(value.password, sizeof(value.password)) ||
      !validHost(value.host) || !safeString(value.workspace, sizeof(value.workspace)) ||
      !validLowerHex(value.workspace, 64) ||
      !safeString(value.deviceId, sizeof(value.deviceId)) ||
      !safeString(value.token, sizeof(value.token))) return false;
  const bool hasId = value.deviceId[0] != '\0';
  const bool hasToken = value.token[0] != '\0';
  if (hasId != hasToken) return false;
  if (hasId && (!roombaValidRequestId(value.deviceId, sizeof(value.deviceId)) ||
                !validLowerHex(value.token, 64))) return false;
  return true;
}

bool saveConfigAndVerify() {
  if (EEPROM.length() < EEPROM_MOTION_OFFSET) return false;
  cfg.magic = CONFIG_MAGIC;
  cfg.version = CONFIG_VERSION;
  cfg.crc = configChecksum(cfg);
  EEPROM.put(0, cfg);
  Config verify{};
  EEPROM.get(0, verify);
  if (!validConfig(verify) || memcmp(&verify, &cfg, sizeof(cfg)) != 0) {
    configStorageFault = true;
    return false;
  }
  cfg = verify;
  return true;
}

bool validLegacyConfig(const LegacyConfig& value) {
  return value.magic == LEGACY_CONFIG_MAGIC &&
      safeString(value.model, sizeof(value.model)) && strcmp(value.model, "551") == 0 &&
      safeString(value.ssid, sizeof(value.ssid)) && value.ssid[0] &&
      safeString(value.password, sizeof(value.password)) &&
      validHost(value.host) && safeString(value.workspace, sizeof(value.workspace)) &&
      validLowerHex(value.workspace, 64) &&
      safeString(value.deviceId, sizeof(value.deviceId)) &&
      roombaValidRequestId(value.deviceId, sizeof(value.deviceId)) &&
      safeString(value.token, sizeof(value.token)) && validLowerHex(value.token, 64);
}

bool bytesAre(const void* data, size_t length, uint8_t expected) {
  const uint8_t* bytes = static_cast<const uint8_t*>(data);
  for (size_t i = 0; i < length; ++i) if (bytes[i] != expected) return false;
  return true;
}

bool loadConfig() {
  if (EEPROM.length() < EEPROM_MOTION_OFFSET ||
      EEPROM.length() < EEPROM_BOOTSTRAP_OFFSET + sizeof(RoombaBootstrapRecord)) {
    configStorageFault = true;
    return false;
  }
  LegacyConfig legacy{};
  EEPROM.get(0, legacy);
  if (legacy.magic == CONFIG_MAGIC) {
    EEPROM.get(0, cfg);
    if (!validConfig(cfg)) {
      configStorageFault = true;
      return false;
    }
    return true;
  }
  if (legacy.magic == LEGACY_CONFIG_MAGIC) {
    if (!validLegacyConfig(legacy)) {
      configStorageFault = true;
      return false;
    }
    memset(&cfg, 0, sizeof(cfg));
    memcpy(cfg.model, legacy.model, sizeof(cfg.model));
    memcpy(cfg.ssid, legacy.ssid, sizeof(cfg.ssid));
    memcpy(cfg.password, legacy.password, sizeof(cfg.password));
    memcpy(cfg.host, legacy.host, sizeof(cfg.host));
    memcpy(cfg.workspace, legacy.workspace, sizeof(cfg.workspace));
    memcpy(cfg.deviceId, legacy.deviceId, sizeof(cfg.deviceId));
    memcpy(cfg.token, legacy.token, sizeof(cfg.token));
    if (!saveConfigAndVerify()) {
      configStorageFault = true;
      return false;
    }
    Serial.println("openlaunch: migrated known Roomba configuration");
    return true;
  }
  if ((legacy.magic == 0 && bytesAre(&legacy, sizeof(legacy), 0)) ||
      (legacy.magic == 0xFFFFFFFFUL && bytesAre(&legacy, sizeof(legacy), 0xFF))) {
    memset(&cfg, 0, sizeof(cfg));
    return true;
  }
  configStorageFault = true;
  return false;
}

RoombaBootstrapState loadBootstrap() {
  RoombaBootstrapState state = bootstrapStore.load(bootstrapRecord, cfg.workspace);
  if (state == RoombaBootstrapState::Invalid || state == RoombaBootstrapState::NoSpace) {
    configStorageFault = true;
    return state;
  }
  return state;
}

bool beginBootstrap(const char* masterAuthorization, const char* requestId,
                    uint64_t createdAtMs) {
  if (!bootstrapStore.begin(masterAuthorization, requestId, createdAtMs,
                            cfg.workspace)) {
    bootstrapState = loadBootstrap();
    return false;
  }
  bootstrapState = loadBootstrap();
  return bootstrapState == RoombaBootstrapState::Pending;
}

bool clearBootstrap() {
  if (!bootstrapStore.clear()) return false;
  bootstrapRecord = RoombaBootstrapRecord{};
  bootstrapState = RoombaBootstrapState::Empty;
  return true;
}

bool recoverBootstrapAtStartup(bool configLoaded) {
  bootstrapState = loadBootstrap();
  if (!configLoaded || configStorageFault) return false;
  if (bootstrapState != RoombaBootstrapState::Empty &&
      roombaBootstrapNeedsStartupCleanup(
          cfg.magic == CONFIG_MAGIC && validConfig(cfg),
          cfg.deviceId[0] != '\0', cfg.token[0] != '\0')) {
    if (!clearBootstrap()) {
      configStorageFault = true;
      Serial.println("openlaunch: paired identity retained; master-token cleanup failed; hardware locked");
      return false;
    }
  }
  return !configStorageFault;
}

// ArduinoJson writer with bounded storage; avoids a second full JSON allocation.
class RoombaHttpBodyWriter {
 public:
  explicit RoombaHttpBodyWriter(HttpClient& client) : client_(client) {}
  size_t write(uint8_t byte) {
    if (!ok_) return 0;
    buffer_[used_++] = byte;
    if (used_ == sizeof(buffer_) && !flush()) return 0;
    return 1;
  }
  size_t write(const uint8_t* data, size_t size) {
    size_t written = 0;
    while (written < size && write(data[written])) ++written;
    return written;
  }
  bool flush() {
    if (!ok_) return false;
    size_t offset = 0;
    while (offset < used_) {
      const size_t sent = client_.write(buffer_ + offset, used_ - offset);
      if (sent == 0 || sent > used_ - offset) { ok_ = false; return false; }
      offset += sent;
    }
    used_ = 0;
    return true;
  }
 private:
  HttpClient& client_;
  uint8_t buffer_[256] = {};
  size_t used_ = 0;
  bool ok_ = true;
};

bool post(const String& path, JsonDocument& data, JsonDocument& response,
          int* responseStatus = nullptr, const char* bearerOverride = nullptr) {
  WiFiSSLClient tls;
  HttpClient client(tls, cfg.host, 443);
  client.setHttpResponseTimeout(12000);
  if (data.overflowed()) {
    if (responseStatus) *responseStatus = -5;
    return false;
  }
  const size_t bodyLength = measureJson(data);
  client.beginRequest();
  client.post(path);
  client.sendHeader("User-Agent", "openlaunch-device/1");
  client.sendHeader("Content-Type", "application/json");
  client.sendHeader("Content-Length", bodyLength);
  client.sendHeader("x-openlaunch-workspace", cfg.workspace);
  if (bearerOverride && bearerOverride[0])
    client.sendHeader("Authorization", String("Bearer ") + bearerOverride);
  else if (cfg.token[0])
    client.sendHeader("Authorization", String("Bearer ") + cfg.token);
  client.beginBody();
  RoombaHttpBodyWriter writer(client);
  const size_t written = serializeJson(data, writer);
  if (written != bodyLength || !writer.flush()) {
    if (responseStatus) *responseStatus = -4;
    client.stop();
    return false;
  }
  client.endRequest();
  const int status = client.responseStatusCode();
  if (responseStatus) *responseStatus = status;
  if (status < 200 || status >= 300) {
    if (bearerOverride && client.contentLength() >= 0 && client.contentLength() <= 2048) {
      JsonDocument failure;
      if (!deserializeJson(failure, client.responseBody())) {
        const char* code = failure["error"]["code"] | "";
        size_t length = strlen(code);
        bool safe = length > 0 && length < sizeof(lastAttachErrorCode);
        for (size_t i = 0; i < length && safe; ++i)
          safe = (code[i] >= 'a' && code[i] <= 'z') || code[i] == '_';
        if (safe) memcpy(lastAttachErrorCode, code, length + 1);
        const char* message = failure["error"]["message"] | "";
        if (!strcmp(code, "invalid_json") && !strncmp(message, "Invalid JSON (bytes=", 19)) {
          size_t n = strlen(message);
          bool bounded = n < sizeof(lastAttachDiagnostic);
          for (size_t i = 0; i < n && bounded; ++i) {
            const char c = message[i];
            bounded = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
              (c >= 'A' && c <= 'Z') || c == ' ' || c == '(' || c == ')' || c == ',' || c == '=' || c == '-';
          }
          if (bounded) memcpy(lastAttachDiagnostic, message, n + 1);
        }
      }
    }
    client.stop();
    return false;
  }
  const int length = client.contentLength();
  if (length > 8192) {
    client.stop();
    return false;
  }
  String payload = client.responseBody();
  client.stop();
  if (payload.length() > 8192) return false;
  return !deserializeJson(response, payload);
}

bool writePendingResult(const RoombaPendingResult& next) {
  if (!validRoombaPendingResult(next)) return false;
  EEPROM.put(EEPROM_RESULT_OFFSET, next);
  RoombaPendingResult check;
  EEPROM.get(EEPROM_RESULT_OFFSET, check);
  if (memcmp(&check, &next, sizeof(next)) != 0 ||
      !validRoombaPendingResult(check)) {
    resultJournalReady = false;
    resultJournalFault = true;
    return false;
  }
  pendingResult = check;
  resultJournalReady = true;
  return true;
}

bool clearPendingResult() {
  RoombaPendingResult empty = {};
  EEPROM.put(EEPROM_RESULT_OFFSET, empty);
  RoombaPendingResult check;
  EEPROM.get(EEPROM_RESULT_OFFSET, check);
  if (memcmp(&check, &empty, sizeof(empty)) != 0) {
    resultJournalReady = false;
    resultJournalFault = true;
    return false;
  }
  pendingResult = empty;
  resultJournalReady = true;
  return true;
}

bool tryDeliverPendingResult() {
  if (!resultJournalReady || !validRoombaPendingResult(pendingResult) ||
      resultJournalFault || resultAuthRevoked) return false;
  const uint64_t now = static_cast<uint64_t>(WiFi.getTime()) * 1000ULL;
  if (WiFi.getTime() < 1700000000UL || now >= pendingResult.expiresAt) {
    if (!resultExpiryReported) {
      Serial.println("openlaunch: result delivery uncertain; action expired; USB reset required to clear journal");
      resultExpiryReported = true;
    }
    return false;
  }
  if (static_cast<int32_t>(millis() - nextResultAttemptMs) < 0) return false;

  JsonDocument request, response;
  if (deserializeJson(request, pendingResult.payload, pendingResult.payloadLength)) {
    resultJournalFault = true;
    Serial.println("openlaunch: pending result journal is unreadable; hardware locked");
    return false;
  }
  int status = 0;
  const bool delivered = post(String("/v1/device/") + cfg.deviceId + "/result",
                              request, response, &status);
  if (status == 401 || status == 403 || status == 404) {
    resultAuthRevoked = true;
    Serial.println("openlaunch: device access revoked; pending result retained and retries stopped");
    return false;
  }
  bool matches = false;
  if (delivered && response["data"]["id"] == pendingResult.actionId &&
      response["data"]["status"] == pendingResult.status) {
    String expected, actual;
    serializeJson(request["result"], expected);
    serializeJson(response["data"]["result"], actual);
    matches = roombaResultResponseMatches(pendingResult,
        response["data"]["id"] | "", response["data"]["status"] | "",
        expected.c_str(), actual.c_str());
  }
  if (matches) {
    if (clearPendingResult()) {
      resultRetryDelayMs = 1000;
      resultExpiryReported = false;
      Serial.println("openlaunch: result delivery confirmed by service");
      return true;
    }
    Serial.println("openlaunch: result confirmed but journal clear failed; hardware locked");
    return false;
  }
  nextResultAttemptMs = millis() + resultRetryDelayMs;
  if (resultRetryDelayMs < 30000) resultRetryDelayMs *= 2;
  if (resultRetryDelayMs > 30000) resultRetryDelayMs = 30000;
  return false;
}

bool queueResult(JsonDocument& ack) {
  String payload;
  serializeJson(ack, payload);
  RoombaPendingResult next = makeRoombaPendingResult(
      ack["actionId"] | "", ack["status"] | "", activeActionExpiresAt,
      payload.c_str(), payload.length());
  if (!writePendingResult(next)) {
    driveAdapter.stop();
    resultJournalFault = true;
    Serial.println("openlaunch: could not persist action result; hardware locked; USB reset required");
    return false;
  }
  tryDeliverPendingResult();
  return true;
}

void setup() {
  Serial.begin(115200);
  if (ROOMBA_REQUIRE_LOCAL_CONTACTS) {
    pinMode(LOCAL_ENABLE_PIN, INPUT_PULLUP);
    pinMode(ESTOP_OK_PIN, INPUT_PULLUP);
    localControl.allows(false, digitalRead(LOCAL_ENABLE_PIN) == LOW,
        digitalRead(ESTOP_OK_PIN) == LOW);
  }
  // Establish Safe mode and send stop before any USB or network wait so a
  // prior latched drive request is cleared as soon as this sketch starts.
  roombaReady = roomba.begin();
  if (roombaReady) roomba.stop();
  Serial.setTimeout(100);
  const bool configLoaded = loadConfig();
  recoverBootstrapAtStartup(configLoaded);
  EEPROM.get(EEPROM_MOTION_OFFSET, motionRecord);
  motionReady = roombaReady && validRoombaMotionRecord(motionRecord);
  EEPROM.get(EEPROM_RESULT_OFFSET, pendingResult);
  resultJournalReady = emptyRoombaResultJournal(pendingResult);
  if (validRoombaPendingResult(pendingResult)) resultJournalReady = true;
  if (!resultJournalReady) {
    resultJournalFault = true;
    Serial.println("openlaunch: result journal invalid; hardware locked; explicit USB reset required");
  }
  if (!roombaReady) Serial.println("openlaunch: Roomba initialization failed; motion locked");
  if (roombaReady && motionReady && cfg.magic == CONFIG_MAGIC && cfg.token[0] &&
      strcmp(cfg.model, "551") == 0) roomba.actuators().definePredefinedSongs();
  if (roombaReady && !motionReady) driveAdapter.stop();
  if (cfg.magic != CONFIG_MAGIC)
    Serial.println("openlaunch: ready for USB SDK-token provisioning; credentials are never printed");
}

void emitStatus() {
  JsonDocument out;
  out["event"] = "status";
  out["adapter"] = "roomba-551";
  out["protocolVersion"] = 1;
  out["state"] = (configStorageFault || resultJournalFault)
      ? "storage_error" : (cfg.magic == CONFIG_MAGIC && cfg.token[0] && cfg.deviceId[0])
      ? "paired" : bootstrapState == RoombaBootstrapState::Pending
      ? "configured" : "unconfigured";
  out["pendingResult"] = pendingResult.pending;
  out["manifestPublished"] = manifestPublished;
  out["manifestPublishStopped"] = manifestPublishStopped;
  out["configured"] = cfg.magic == CONFIG_MAGIC;
  out["paired"] = cfg.magic == CONFIG_MAGIC && cfg.token[0] && cfg.deviceId[0];
  out["pendingAttach"] = bootstrapState == RoombaBootstrapState::Pending;
  out["attachStopped"] = attachStopped;
  out["attachmentHttpStatus"] = lastAttachHttpStatus;
  out["attachmentErrorCode"] = lastAttachErrorCode;
  out["attachmentDiagnostic"] = lastAttachDiagnostic;
  out["storageFault"] = configStorageFault || resultJournalFault;
  out["wifiConnected"] = WiFi.status() == WL_CONNECTED;
  out["controlWiring"] = ROOMBA_REQUIRE_LOCAL_CONTACTS ? "local_contacts" : "serial_only";
  out["controlReady"] = driveIO.locallyArmed();
  out["sensorLinkDesynced"] = roombaSensorLinkDesynced;
  if (cfg.magic == CONFIG_MAGIC && cfg.deviceId[0]) out["deviceId"] = cfg.deviceId;
  serializeJson(out, Serial); Serial.println();
}

void emitError(const char* code) {
  JsonDocument out; out["event"] = "error"; out["code"] = code;
  serializeJson(out, Serial); Serial.println();
}

bool resetConfiguration() {
  // Reset is an explicit host command. Clear every credential-bearing and
  // replay-sensitive record, then read back each region before unlocking.
  Config emptyConfig{};
  EEPROM.put(0, emptyConfig);
  Config checkConfig{}; EEPROM.get(0, checkConfig);
  if (memcmp(&emptyConfig, &checkConfig, sizeof(emptyConfig)) != 0) return false;
  RoombaMotionRecord emptyMotion{};
  EEPROM.put(EEPROM_MOTION_OFFSET, emptyMotion);
  RoombaMotionRecord checkMotion{}; EEPROM.get(EEPROM_MOTION_OFFSET, checkMotion);
  if (memcmp(&emptyMotion, &checkMotion, sizeof(emptyMotion)) != 0) return false;
  if (!clearPendingResult() || !clearBootstrap()) return false;
  memset(&cfg, 0, sizeof(cfg));
  motionReady = false; motionRecord = {};
  resultJournalReady = true; resultJournalFault = false; resultAuthRevoked = false;
  resultExpiryReported = false; pendingResult = {};
  attachStopped = false; attachExpiredReported = false; attachRetryScheduled = false;
  configStorageFault = false; WiFi.disconnect();
  driveAdapter.stop();
  return true;
}

bool configureSdk(JsonObjectConst input) {
  if (configStorageFault || resultJournalFault ||
      bootstrapState != RoombaBootstrapState::Empty) return false;
  if (cfg.magic == CONFIG_MAGIC && cfg.token[0]) return false;
  Config next{};
  if (!input["model"].isNull() && !input["model"].is<const char*>()) return false;
  const char* model = input["model"] | "551";
  if (strcmp(model, "551") != 0) return false;
  memcpy(next.model, "551", 4);
  if (!safeCopy(next.ssid, sizeof(next.ssid), input["ssid"]) ||
      !next.ssid[0] || !safeCopy(next.password, sizeof(next.password), input["password"]) ||
      !safeCopy(next.host, sizeof(next.host), input["host"]) ||
      !safeCopy(next.workspace, sizeof(next.workspace), input["workspace"]) ||
      !validHost(next.host) || !validLowerHex(next.workspace, 64)) return false;
  char tokenWorkspace[65] = {};
  const char* standardToken = input["token"] | "";
  const char* legacyToken = input["masterAuthorization"] | "";
  if (standardToken[0] && legacyToken[0] && strcmp(standardToken, legacyToken) != 0)
    return false;
  const char* master = standardToken[0] ? standardToken : legacyToken;
  const char* requestId = input["requestId"] | "";
  uint64_t createdAtMs = 0;
  if (!roombaMasterWorkspace(master, 139, tokenWorkspace) ||
      strcmp(tokenWorkspace, next.workspace) != 0 ||
      !roombaValidRequestId(requestId) ||
      !readJsonUnsignedInteger(input["requestCreatedAtMs"], createdAtMs) ||
      createdAtMs == 0) return false;
  next.magic = CONFIG_MAGIC; next.version = CONFIG_VERSION;
  next.crc = configChecksum(next);
  EEPROM.put(0, next);
  EEPROM.get(0, cfg);
  if (!validConfig(cfg) || cfg.token[0]) { configStorageFault = true; return false; }
  // Persist the idempotency key and master token before making any HTTP call.
  if (!beginBootstrap(master, requestId, createdAtMs)) {
    configStorageFault = true; return false;
  }
  if (!writeMotionRecord(0)) { configStorageFault = true; return false; }
  attachStopped = false; attachRetryDelayMs = 5000; attachRetryScheduled = false;
  return true;
}

void handleProvisioningLine(const String& line) {
  JsonDocument input;
  if (deserializeJson(input, line) || !input.is<JsonObject>()) {
    emitError("invalid_json"); return;
  }
  const char* command = input["command"] | "";
  if (!strcmp(command, "status")) { emitStatus(); return; }
  if (!strcmp(command, "reset")) {
    if (resetConfiguration()) { JsonDocument out; out["event"] = "reset"; serializeJson(out, Serial); Serial.println(); }
    else emitError("reset_failed_storage_locked");
    return;
  }
  if (!strcmp(command, "configure")) {
    if (cfg.magic == CONFIG_MAGIC && cfg.token[0]) { emitError("already_paired_reset_required"); return; }
    if (!configureSdk(input.as<JsonObjectConst>())) { emitError("invalid_or_pending_configuration"); return; }
    JsonDocument out; out["event"] = "configured"; serializeJson(out, Serial); Serial.println();
    return;
  }
  emitError("unknown_command");
}

void serviceSerial() {
  static char line[4097]; static size_t used = 0; static bool overflow = false;
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      if (!overflow && used) {
        line[used] = '\0';
        String command(line);
        memset(line, 0, sizeof(line));
        used = 0;
        handleProvisioningLine(command);
        command = "";
      }
      else if (overflow) emitError("line_too_large");
      used = 0; overflow = false;
    } else if (c != '\r') {
      if (used + 1 < sizeof(line)) line[used++] = c;
      else overflow = true;
    }
  }
}

void attemptProvisioning() {
  if (bootstrapState != RoombaBootstrapState::Pending || attachStopped ||
      configStorageFault || WiFi.status() != WL_CONNECTED) return;
  const unsigned long epoch = WiFi.getTime();
  if (epoch < 1700000000UL) return; // Keep the durable retry record until time is known.
  const uint64_t nowMs = static_cast<uint64_t>(epoch) * 1000ULL;
  if (nowMs < bootstrapRecord.requestCreatedAtMs) return; // Whole-second device clock may trail host time.
  if (roombaBootstrapExpired(bootstrapRecord, cfg.workspace, nowMs)) {
    attachStopped = true;
    if (!attachExpiredReported) { emitError("attachment_retry_expired_check_inventory"); attachExpiredReported = true; }
    return;
  }
  if (attachRetryScheduled && static_cast<int32_t>(millis() - attachRetryAtMs) < 0) return;
  JsonDocument request, response;
  request["requestId"] = bootstrapRecord.requestId;
  addRoombaManifest(request);
  int status = 0;
  const bool attached = post("/v1/sdk/devices", request, response, &status,
                             bootstrapRecord.masterAuthorization);
  lastAttachHttpStatus = status;
  if (attached && safeCopy(cfg.deviceId, sizeof(cfg.deviceId), response["data"]["deviceId"]) &&
      safeCopy(cfg.token, sizeof(cfg.token), response["data"]["token"]) &&
      isUuid(cfg.deviceId) && validLowerHex(cfg.token, 64)) {
    if (!saveConfigAndVerify() || !clearBootstrap()) {
      configStorageFault = true; driveAdapter.stop(); emitError("attach_saved_cleanup_failed_locked"); return;
    }
    if (roombaReady) roomba.actuators().definePredefinedSongs();
    manifestPublished = true;
    attachStopped = false; attachRetryScheduled = false; attachRetryDelayMs = 5000;
    JsonDocument out; out["event"] = "paired"; out["deviceId"] = cfg.deviceId;
    serializeJson(out, Serial); Serial.println(); return;
  }
  if (status >= 400 && status < 500 && status != 429) {
    attachStopped = true;
    JsonDocument error; error["event"] = "error";
    error["code"] = status == 409 ? "attachment_conflict_or_expired_check_inventory" : "attachment_rejected";
    error["httpStatus"] = status;
    serializeJson(error, Serial); Serial.println();
    return;
  }
  attachRetryAtMs = millis() + attachRetryDelayMs; attachRetryScheduled = true;
  if (attachRetryDelayMs < 60000) attachRetryDelayMs *= 2;
  if (attachRetryDelayMs > 60000) attachRetryDelayMs = 60000;
}

bool expiredOrClockUnknown(JsonObjectConst cmd, uint16_t neededMs = 0) {
  uint64_t expires = 0;
  if (!readJsonUnsignedInteger(cmd["expiresAt"], expires)) return true;
  const unsigned long epoch = WiFi.getTime();
  return !roombaHasExecutionBudget(epoch, expires, neededMs);
}

bool validActionTimeWindow(uint64_t createdAt, uint64_t expiresAt) {
  if (createdAt == 0 || expiresAt <= createdAt ||
      expiresAt - createdAt > 300000ULL) return false;
  const unsigned long epoch = WiFi.getTime();
  if (epoch < 1700000000UL) return false;
  const uint64_t nowLowerBoundMs = static_cast<uint64_t>(epoch) * 1000ULL;
  return createdAt <= nowLowerBoundMs + 1000ULL;
}

void reportResult(const char* id, bool succeeded, const char* error = nullptr) {
  JsonDocument ack, reply;
  ack["actionId"] = id;
  ack["status"] = succeeded ? "succeeded" : "failed";
  if (error) ack["result"]["error"] = error;
  else {
    ack["result"]["accepted"] = true;
    ack["result"]["transport"] = "serial_command_sent";
  }
  ack["result"]["physicalVerified"] = false;
  queueResult(ack);
}

void addMovementManifest(JsonArray functions) {
  JsonObject stop = functions.add<JsonObject>();
  stop["name"] = "roomba.stop";
  stop["title"] = "Stop Roomba";
  stop["description"] = "If an autonomous run is active, enter Safe mode to abort it, then send zero drive and brush-off; Safe mode remains until explicitly resumed.";
  stop["access"] = "write";
  JsonObject schema = stop["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  schema["properties"].to<JsonObject>();
  schema["required"].to<JsonArray>();
  schema["additionalProperties"] = false;

  JsonObject drive = functions.add<JsonObject>();
  drive["name"] = "roomba.drive";
  drive["title"] = "Drive Roomba briefly";
  drive["description"] = ROOMBA_REQUIRE_LOCAL_CONTACTS
      ? "Drive at bounded speed for at most one second with local enable and stop contacts."
      : "Drive over serial in Safe mode at bounded speed for at most one second. No D6/D7 contacts required.";
  drive["access"] = "write";
  schema = drive["inputSchema"].to<JsonObject>();
  schema["type"] = "object";
  JsonArray required = schema["required"].to<JsonArray>();
  required.add("velocityMmS"); required.add("radiusMm"); required.add("durationMs");
  schema["additionalProperties"] = false;
  JsonObject props = schema["properties"].to<JsonObject>();
  addIntegerProperty(props, "velocityMmS", -150, 150);
  addIntegerProperty(props, "radiusMm", -2000, 2000);
  addIntegerProperty(props, "durationMs", 1, 1000);
}

void addRoombaManifest(JsonDocument& request) {
  JsonObject manifest = request["manifest"].to<JsonObject>();
  manifest["name"] = "uno-r4-wifi-roomba-551";
  manifest["kind"] = "uno-r4-wifi";
  JsonArray capabilities = manifest["capabilities"].to<JsonArray>();
  capabilities.add("device.health");
  capabilities.add("roomba.drive");
  capabilities.add("roomba.stop");
  JsonArray functions = manifest["functions"].to<JsonArray>();
  addRoombaFeatureManifest(capabilities, functions);
  addMovementManifest(functions);
}

bool publishPairedManifest() {
  if (!cfg.deviceId[0] || !cfg.token[0]) return false;
  JsonDocument request, response;
  addRoombaManifest(request);
  int status = 0;
  const bool delivered = post(String("/v1/device/") + cfg.deviceId + "/manifest",
                              request, response, &status);
  if (delivered && response["data"]["ok"] == true &&
      response["data"]["grantsRevoked"].is<bool>()) {
    manifestPublished = true;
    manifestPublishDelayMs = 5000;
    const bool grantsRevoked = response["data"]["grantsRevoked"].as<bool>();
    Serial.println(grantsRevoked
        ? "openlaunch: manifest updated; device grants revoked and require owner regrant"
        : "openlaunch: manifest confirmed; existing device grants retained");
    return true;
  }
  if (status >= 400 && status < 500 && status != 429) {
    manifestPublishStopped = true;
    Serial.println("openlaunch: manifest update rejected; paired identity retained");
    return false;
  }
  nextManifestPublishMs = millis() + manifestPublishDelayMs;
  if (manifestPublishDelayMs < 60000) manifestPublishDelayMs *= 2;
  if (manifestPublishDelayMs > 60000) manifestPublishDelayMs = 60000;
  return false;
}

bool isKnownRoombaFeature(const char* capability) {
  static const char* const names[] = {
    "roomba.drive", "roomba.drive_direct", "roomba.stop",
    "roomba.sensor.read", "roomba.leds.set", "roomba.tone.play",
    "roomba.song.play", "roomba.brushes.burst", "roomba.resume_safe",
    "roomba.clean", "roomba.dock", "roomba.pause"
  };
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i)
    if (strcmp(capability, names[i]) == 0) return true;
  return false;
}

bool isRoombaMotionFeature(const char* capability) {
  return strcmp(capability, "roomba.drive") == 0 ||
      strcmp(capability, "roomba.drive_direct") == 0 ||
      strcmp(capability, "roomba.brushes.burst") == 0;
}

bool requiresLocalInterlock(const char* capability) {
  return isRoombaMotionFeature(capability) || strcmp(capability, "roomba.resume_safe") == 0 ||
      strcmp(capability, "roomba.clean") == 0 || strcmp(capability, "roomba.dock") == 0;
}

uint16_t requiredActionTimeMs(const char* capability) {
  if (isRoombaMotionFeature(capability)) return 1000;
  if (strcmp(capability, "roomba.sensor.read") == 0) return 225;
  if (strcmp(capability, "roomba.tone.play") == 0) return 512;
  if (strcmp(capability, "roomba.song.play") == 0) return 1600;
  if (strcmp(capability, "roomba.resume_safe") == 0) return 40;
  return 0;
}

bool persistActionTimestamp(uint64_t createdAt) {
  if (!motionReady || !roombaTimestampIsNew(createdAt, motionRecord)) return false;
  return writeMotionRecord(createdAt);
}

void submitFeatureResult(const char* id, bool succeeded, JsonObjectConst result,
                         const char* error) {
  JsonDocument ack, response;
  ack["actionId"] = id;
  ack["status"] = succeeded ? "succeeded" : "failed";
  JsonObject out = ack["result"].to<JsonObject>();
  if (!result.isNull()) out.set(result);
  if (error) out["error"] = error;
  if (!out["physicalVerified"].is<bool>()) out["physicalVerified"] = false;
  queueResult(ack);
}

bool isUuid(const char* value) {
  if (!value || strlen(value) != 36) return false;
  for (uint8_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (value[i] != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(value[i]))) {
      return false;
    }
  }
  return true;
}

bool validDriveArguments(JsonObjectConst args) {
  if (args.isNull() || args.size() != 3 ||
      !args["velocityMmS"].is<int>() || !args["radiusMm"].is<int>() ||
      !args["durationMs"].is<int>()) return false;
  const int velocity = args["velocityMmS"].as<int>();
  const int radius = args["radiusMm"].as<int>();
  const int duration = args["durationMs"].as<int>();
  if (args["velocityMmS"].as<double>() != velocity ||
      args["radiusMm"].as<double>() != radius ||
      args["durationMs"].as<double>() != duration) return false;
  return velocity >= -150 && velocity <= 150 && radius >= -2000 && radius <= 2000 &&
         duration >= 1 && duration <= 1000;
}

void handleAction(JsonObject cmd) {
  if (!resultJournalReady || resultJournalFault || pendingResult.pending) {
    driveAdapter.stop();
    return;
  }
  const char* id = cmd["id"] | "";
  if (!isUuid(id)) {
    driveAdapter.stop();
    return;
  }
  const bool duplicate = strcmp(id, lastAction) == 0;
  if (!duplicate) {
    strncpy(lastAction, id, sizeof(lastAction) - 1);
    lastAction[sizeof(lastAction) - 1] = 0;
  }
  const char* capability = cmd["capability"] | "";
  activeActionExpiresAt = 0;
  readJsonUnsignedInteger(cmd["expiresAt"], activeActionExpiresAt);

  const bool isStop = strcmp(capability, "roomba.stop") == 0;
  // A stop request is handled locally before checking expiry or arguments.
  if (isStop) driveAdapter.stop();
  if (duplicate) {
    driveAdapter.stop();
    return;
  }

  uint64_t createdAt = 0;
  uint64_t expiresAt = 0;
  const JsonObjectConst args = cmd["args"].as<JsonObjectConst>();
  const bool validEnvelope = cmd["deviceId"] == cfg.deviceId &&
      readJsonUnsignedInteger(cmd["createdAt"], createdAt) &&
      readJsonUnsignedInteger(cmd["expiresAt"], expiresAt) &&
      validActionTimeWindow(createdAt, expiresAt) &&
      cmd["status"] == "received" && !args.isNull();
  if (!validEnvelope) {
    driveAdapter.stop();
    reportResult(id, false, "invalid_arguments_or_envelope");
    return;
  }
  if (isStop) {
    const bool validArgs = args.size() == 0;
    bool journaled = true;
    if (validArgs && motionReady && roombaTimestampIsNew(createdAt, motionRecord))
      journaled = writeMotionRecord(createdAt);
    reportResult(id, validArgs && roombaReady && journaled,
                 !validArgs ? "invalid_arguments" : (!roombaReady ? "roomba_unavailable" :
                 (!journaled ? "motion_journal_write_failed" : nullptr)));
    return;
  }
  if (expiredOrClockUnknown(cmd, requiredActionTimeMs(capability))) {
    driveAdapter.stop();
    reportResult(id, false, "clock_unavailable_or_expired");
    return;
  }
  if (!strcmp(capability, "device.health")) {
    JsonDocument ack, reply;
    ack["actionId"] = id; ack["status"] = "succeeded";
    ack["result"]["uptimeMs"] = millis(); ack["result"]["rssi"] = WiFi.RSSI();
    ack["result"]["board"] = "uno-r4-wifi";
    ack["result"]["model"] = cfg.model;
    ack["result"]["controlWiring"] = ROOMBA_REQUIRE_LOCAL_CONTACTS ? "local_contacts" : "serial_only";
    ack["result"]["controlReady"] = driveIO.locallyArmed();
    ack["result"]["sensorLinkDesynced"] = roombaSensorLinkDesynced;
    ack["result"]["physicalVerified"] = false;
    queueResult(ack);
    return;
  }
  if (!isKnownRoombaFeature(capability)) {
    driveAdapter.stop();
    reportResult(id, false, "unsupported_capability");
    return;
  }
  if (!roombaReady || cfg.magic != CONFIG_MAGIC || strcmp(cfg.model, "551") != 0) {
    driveAdapter.stop();
    reportResult(id, false, "roomba_unavailable_or_model_unconfirmed");
    return;
  }
  if (requiresLocalInterlock(capability) && !driveIO.locallyArmed()) {
    driveAdapter.stop();
    reportResult(id, false, ROOMBA_REQUIRE_LOCAL_CONTACTS ? "local_interlock_open" : "control_not_ready");
    return;
  }
  if (strcmp(capability, "roomba.drive") == 0 && !validDriveArguments(args)) {
    driveAdapter.stop();
    reportResult(id, false, "invalid_arguments");
    return;
  }

  // Persist every OI write's server creation time before sending it. This
  // prevents an already-dispatched write from running again after reset.
  const bool sensorRead = strcmp(capability, "roomba.sensor.read") == 0;
  if (!sensorRead) {
    if (!motionReady || !roombaTimestampIsNew(createdAt, motionRecord)) {
      driveAdapter.stop();
      reportResult(id, false, "replayed_or_unavailable_motion_journal");
      return;
    }
    if (!persistActionTimestamp(createdAt)) {
      driveAdapter.stop();
      reportResult(id, false, "motion_journal_write_failed");
      return;
    }
  }

  if (strcmp(capability, "roomba.drive") == 0) {
    const int velocity = args["velocityMmS"].as<int>();
    const int radius = args["radiusMm"].as<int>();
    const int duration = args["durationMs"].as<int>();
    const RoombaDriveResult result = driveAdapter.run(
        static_cast<int16_t>(velocity), static_cast<int16_t>(radius),
        static_cast<uint16_t>(duration));
    reportResult(id, result == RoombaDriveResult::COMPLETED,
                 result == RoombaDriveResult::COMPLETED ? nullptr : "motion_stopped_by_interlock_or_bounds");
    return;
  }

  if (isRoombaMotionFeature(capability) && autonomyGuard.active())
    driveAdapter.stop();

  JsonDocument featureResponse;
  const char* error = nullptr;
  const bool handled = handleRoombaFeature(capability, args, roomba, driveIO,
      featureResponse.to<JsonObject>(), error);
  if (!handled) {
    driveAdapter.stop();
    reportResult(id, false, "unsupported_capability");
    return;
  }
  if (error) driveAdapter.stop();
  else if (strcmp(capability, "roomba.clean") == 0 ||
           strcmp(capability, "roomba.dock") == 0)
    autonomyGuard.start();
  else if (strcmp(capability, "roomba.pause") == 0 ||
           strcmp(capability, "roomba.resume_safe") == 0)
    autonomyGuard.clear();
  submitFeatureResult(id, error == nullptr, featureResponse.as<JsonObjectConst>(), error);
}

void loop() {
  serviceRoombaAutonomyGuard(autonomyGuard, driveIO, roomba);
  serviceSerial();
  if (cfg.magic != CONFIG_MAGIC || configStorageFault) { delay(20); return; }
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttempt >= 10000) {
    lastWifiAttempt = millis();
    WiFi.begin(cfg.ssid, cfg.password);
  }
  if (bootstrapState == RoombaBootstrapState::Pending) {
    attemptProvisioning();
    delay(20); return;
  }
  if (!cfg.token[0] || !cfg.deviceId[0]) { delay(20); return; }
  if (!resultJournalReady || resultJournalFault || pendingResult.pending || resultAuthRevoked) {
    if (pendingResult.pending) tryDeliverPendingResult();
    delay(20);
    return;
  }
  if (WiFi.status() != WL_CONNECTED) { delay(20); return; }
  if (!manifestPublished && !manifestPublishStopped &&
      static_cast<int32_t>(millis() - nextManifestPublishMs) >= 0)
    publishPairedManifest();
  if (!manifestPublished) { delay(20); return; }
  if (millis() - lastPoll < POLL_INTERVAL_MS) { delay(20); return; }
  lastPoll = millis();
  JsonDocument request, response;
  if (!post(String("/v1/device/") + cfg.deviceId + "/next", request, response) ||
      response["data"].isNull()) return;
  handleAction(response["data"].as<JsonObject>());
}
