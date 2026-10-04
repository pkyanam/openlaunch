/*
 * openlaunch development firmware: HTTPS polling, built-in LED, matrix and
 * health. Provision at 115200 baud with scripts/provision-uno.py. Wi-Fi and
 * device credentials live in plain EEPROM and are not tamper-resistant.
 * WiFiSSLClient performs the board's normal verified TLS connection; there is
 * no insecure TLS mode.
 */
#include <WiFiS3.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <ArduinoGraphics.h>
#include <Arduino_LED_Matrix.h>
#include <EEPROM.h>
#include "ResultJournal.h"
#include "AttachmentClock.h"
#include "HttpBodyWriter.h"

#include <cstdint>
#include <cstddef>
#include <cstring>

struct LegacyConfigV1 {
  uint32_t magic;
  char ssid[33];
  char password[65];
  char host[128];
  char workspace[65];
  char deviceId[37];
  char token[65];
};

struct Config {
  uint32_t magic;
  char ssid[33];
  char password[65];
  char host[128];
  char workspace[65];
  char deviceId[37];
  char token[65];
  char bootstrapToken[139];
  char requestId[37];
  std::uint64_t requestCreatedAtMs;
  std::uint8_t bootstrapMode;
  std::uint32_t crc;
};
static_assert(offsetof(Config, magic) == offsetof(LegacyConfigV1, magic), "EEPROM v1 magic moved");
static_assert(offsetof(Config, ssid) == offsetof(LegacyConfigV1, ssid), "EEPROM v1 SSID moved");
static_assert(offsetof(Config, password) == offsetof(LegacyConfigV1, password), "EEPROM v1 password moved");
static_assert(offsetof(Config, host) == offsetof(LegacyConfigV1, host), "EEPROM v1 host moved");
static_assert(offsetof(Config, workspace) == offsetof(LegacyConfigV1, workspace), "EEPROM v1 workspace moved");
static_assert(offsetof(Config, deviceId) == offsetof(LegacyConfigV1, deviceId), "EEPROM v1 device ID moved");
static_assert(offsetof(Config, token) == offsetof(LegacyConfigV1, token), "EEPROM v1 token moved");

struct ArduinoEepromJournalStorage {
  std::size_t length() const { return static_cast<std::size_t>(EEPROM.length()); }
  void readBlock(std::size_t offset, void *destination, std::size_t length) const {
    auto *bytes = static_cast<std::uint8_t *>(destination);
    for (std::size_t i = 0; i < length; ++i)
      bytes[i] = EEPROM.read(static_cast<int>(offset + i));
  }
  void writeBlock(std::size_t offset, const void *source, std::size_t length) const {
    if (length == sizeof(OpenLaunchResultRecord)) {
      EEPROM.put(static_cast<int>(offset),
                 *static_cast<const OpenLaunchResultRecord *>(source));
      return;
    }
    const auto *bytes = static_cast<const std::uint8_t *>(source);
    for (std::size_t i = 0; i < length; ++i)
      EEPROM.update(static_cast<int>(offset + i), bytes[i]);
  }
};

static OpenLaunchResultJournal<ArduinoEepromJournalStorage> resultJournal(
    ArduinoEepromJournalStorage{}, sizeof(Config));

constexpr uint32_t kMagicV1 = 0x4F4C0001;
constexpr uint32_t kMagicV2 = 0x4F4C0002;
constexpr std::size_t kSerialLineLimit = 1024;
constexpr std::size_t kResponseLimit = 8192;
constexpr std::uint64_t kSdkAttachmentWindowMs = 9ULL * 60ULL * 1000ULL;
constexpr std::uint8_t kBootstrapNone = 0;
constexpr std::uint8_t kBootstrapEnrollment = 1;
constexpr std::uint8_t kBootstrapSdk = 2;

ArduinoLEDMatrix matrix;
Config cfg{};
char serialLine[kSerialLineLimit + 1]{};
std::size_t serialLineLength = 0;
bool serialLineOverflow = false;
bool configured = false;
bool paired = false;
bool provisioningStopped = false;
bool storageFault = false;
bool actionUncertain = false;
bool resultHalted = false;
OpenLaunchJournalState resultJournalState = OpenLaunchJournalState::Empty;
OpenLaunchResultRecord pendingResultRecord{};
unsigned long lastPoll = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastAttachAttempt = 0;
unsigned long lastBootstrapCleanupAttempt = 0;
unsigned long resultRetryAt = 0;
unsigned long resultRetryDelayMs = 3000UL;
bool resultRetryScheduled = false;
int lastHttpStatusCode = 0;

static bool safeCopy(char *dst, std::size_t capacity, JsonVariantConst value) {
  const char *source = value.as<const char *>();
  if (!source || std::strlen(source) >= capacity) return false;
  std::strcpy(dst, source);
  return true;
}

static bool safeString(const char *value, std::size_t capacity) {
  return std::memchr(value, '\0', capacity) != nullptr;
}

static std::uint32_t configCrc(const Config &value) {
  const auto *bytes = reinterpret_cast<const std::uint8_t *>(&value);
  std::uint32_t crc = 0xFFFFFFFFUL;
  for (std::size_t i = 0; i < offsetof(Config, crc); ++i) {
    crc ^= bytes[i];
    for (std::uint8_t bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ ((crc & 1) ? 0xEDB88320UL : 0);
  }
  return ~crc;
}

static bool eepromFits(std::size_t bytes) {
  return EEPROM.length() >= bytes;
}

static bool fullJournalFits() {
  return sizeof(Config) <= static_cast<std::size_t>(EEPROM.length()) &&
      sizeof(OpenLaunchResultRecord) <=
          static_cast<std::size_t>(EEPROM.length()) - sizeof(Config);
}

static bool validV2Record(const Config &value) {
  return value.magic == kMagicV2 && value.crc == configCrc(value) &&
         safeString(value.ssid, sizeof(value.ssid)) &&
         safeString(value.password, sizeof(value.password)) &&
         safeString(value.host, sizeof(value.host)) &&
         safeString(value.workspace, sizeof(value.workspace)) &&
         safeString(value.deviceId, sizeof(value.deviceId)) &&
         safeString(value.token, sizeof(value.token)) &&
         safeString(value.bootstrapToken, sizeof(value.bootstrapToken)) &&
         safeString(value.requestId, sizeof(value.requestId));
}

static void emitEvent(const char *name, const char *field = nullptr,
                      const char *value = nullptr) {
  Serial.print("{\"event\":\"");
  Serial.print(name);
  Serial.print("\"");
  if (field && value) {
    Serial.print(",\"");
    Serial.print(field);
    Serial.print("\":\"");
    Serial.print(value);
    Serial.print("\"");
  }
  Serial.println("}");
}

static void emitStatus() {
  const char *state = storageFault ? "storage_error" :
                      paired ? "paired" : configured ? "configured" : "unconfigured";
  Serial.print("{\"event\":\"status\",\"state\":\"");
  Serial.print(state);
  const bool pending = resultJournalState != OpenLaunchJournalState::Empty;
  Serial.print("\",\"pendingResult\":");
  Serial.print(pending ? "true" : "false");
  Serial.println("}");
}

static void emitError(const char *code) {
  Serial.print("{\"event\":\"error\",\"code\":\"");
  Serial.print(code);
  Serial.println("\"}");
}

static void emitPaired(bool bootstrapCredentialCleared) {
  Serial.print("{\"event\":\"paired\",\"state\":\"paired\",\"bootstrapCredentialCleared\":");
  Serial.print(bootstrapCredentialCleared ? "true" : "false");
  Serial.println("}");
}

static bool saveConfigAndVerify() {
  if (!eepromFits(sizeof(Config))) return false;
  cfg.magic = kMagicV2;
  cfg.crc = configCrc(cfg);
  EEPROM.put(0, cfg);
  Config verify{};
  EEPROM.get(0, verify);
  return validV2Record(verify) &&
         std::strcmp(verify.workspace, cfg.workspace) == 0 &&
         std::strcmp(verify.ssid, cfg.ssid) == 0 &&
         std::strcmp(verify.deviceId, cfg.deviceId) == 0 &&
         std::strcmp(verify.token, cfg.token) == 0 &&
         std::strcmp(verify.bootstrapToken, cfg.bootstrapToken) == 0 &&
         std::strcmp(verify.requestId, cfg.requestId) == 0 &&
         verify.requestCreatedAtMs == cfg.requestCreatedAtMs &&
         verify.bootstrapMode == cfg.bootstrapMode;
}

static bool clearBootstrapCredential() {
  if (!cfg.bootstrapToken[0] && cfg.bootstrapMode == kBootstrapNone) return true;
  char oldToken[sizeof(cfg.bootstrapToken)];
  std::strncpy(oldToken, cfg.bootstrapToken, sizeof(oldToken));
  oldToken[sizeof(oldToken) - 1] = '\0';
  const std::uint8_t oldMode = cfg.bootstrapMode;
  const std::uint64_t oldCreated = cfg.requestCreatedAtMs;
  char oldRequestId[sizeof(cfg.requestId)]{};
  std::strncpy(oldRequestId, cfg.requestId, sizeof(cfg.requestId) - 1);

  std::memset(cfg.bootstrapToken, 0, sizeof(cfg.bootstrapToken));
  std::memset(cfg.requestId, 0, sizeof(cfg.requestId));
  cfg.requestCreatedAtMs = 0;
  cfg.bootstrapMode = kBootstrapNone;
  if (saveConfigAndVerify()) return true;

  std::strncpy(cfg.bootstrapToken, oldToken, sizeof(cfg.bootstrapToken));
  cfg.bootstrapToken[sizeof(cfg.bootstrapToken) - 1] = '\0';
  std::strncpy(cfg.requestId, oldRequestId, sizeof(cfg.requestId));
  cfg.requestId[sizeof(cfg.requestId) - 1] = '\0';
  cfg.requestCreatedAtMs = oldCreated;
  cfg.bootstrapMode = oldMode;
  return false;
}

static bool migrateOrLoadConfig() {
  if (!fullJournalFits() || !eepromFits(sizeof(LegacyConfigV1))) return false;
  Config current{};
  if (eepromFits(sizeof(Config))) EEPROM.get(0, current);
  if (current.magic == kMagicV2) {
    if (!validV2Record(current))
      return false;
    cfg = current;
    paired = cfg.deviceId[0] && cfg.token[0];
    configured = paired || (cfg.ssid[0] && cfg.host[0] && cfg.workspace[0]);
    return true;
  }

  LegacyConfigV1 legacy{};
  EEPROM.get(0, legacy);
  if (legacy.magic != kMagicV1) {
    if (legacy.magic == 0 || legacy.magic == 0xFFFFFFFFUL) return true;
    return false;
  }
  if (!safeString(legacy.ssid, sizeof(legacy.ssid)) ||
      !safeString(legacy.password, sizeof(legacy.password)) ||
      !safeString(legacy.host, sizeof(legacy.host)) ||
      !safeString(legacy.workspace, sizeof(legacy.workspace)) ||
      !safeString(legacy.deviceId, sizeof(legacy.deviceId)) ||
      !safeString(legacy.token, sizeof(legacy.token)))
    return false;

  cfg = Config{};
  std::strncpy(cfg.ssid, legacy.ssid, sizeof(cfg.ssid) - 1);
  std::strncpy(cfg.password, legacy.password, sizeof(cfg.password) - 1);
  std::strncpy(cfg.host, legacy.host, sizeof(cfg.host) - 1);
  std::strncpy(cfg.workspace, legacy.workspace, sizeof(cfg.workspace) - 1);
  std::strncpy(cfg.deviceId, legacy.deviceId, sizeof(cfg.deviceId) - 1);
  std::strncpy(cfg.token, legacy.token, sizeof(cfg.token) - 1);
  cfg.magic = kMagicV2;
  if (!saveConfigAndVerify()) return false;
  paired = cfg.deviceId[0] && cfg.token[0];
  configured = paired || (cfg.ssid[0] && cfg.host[0] && cfg.workspace[0]);
  return true;
}

enum class HttpResult : std::uint8_t { Ok, NetworkError, HttpError, InvalidResponse };

static HttpResult post(const String &path, JsonDocument &data,
                       JsonDocument &response, const char *bearerOverride = nullptr) {
  lastHttpStatusCode = 0;
  if (data.overflowed()) return HttpResult::InvalidResponse;
  const size_t bodyLength = measureJson(data);
  if (bodyLength > 16 * 1024) return HttpResult::InvalidResponse;

  WiFiSSLClient tls;
  HttpClient client(tls, cfg.host, 443);
  client.setHttpResponseTimeout(12000);
  client.beginRequest();
  client.post(path);
  client.sendHeader("Content-Type", "application/json");
  client.sendHeader("Content-Length", bodyLength);
  client.sendHeader("x-openlaunch-workspace", cfg.workspace);
  if (bearerOverride && bearerOverride[0])
    client.sendHeader("Authorization", String("Bearer ") + bearerOverride);
  else if (cfg.token[0])
    client.sendHeader("Authorization", String("Bearer ") + cfg.token);
  client.beginBody();
  openlaunch::HttpBodyWriter<HttpClient> writer(client);
  if (serializeJson(data, writer) != bodyLength || !writer.flush()) {
    client.stop();
    return HttpResult::NetworkError;
  }
  client.endRequest();

  const int status = client.responseStatusCode();
  if (status < 0) {
    client.stop();
    return HttpResult::NetworkError;
  }
  lastHttpStatusCode = status;
  if (status < 200 || status >= 300) {
    client.stop();
    return HttpResult::HttpError;
  }
  const int length = client.contentLength();
  if (length > static_cast<int>(kResponseLimit)) {
    client.stop();
    return HttpResult::InvalidResponse;
  }
  String payload = client.responseBody();
  client.stop();
  if (payload.length() > kResponseLimit || deserializeJson(response, payload))
    return HttpResult::InvalidResponse;
  return HttpResult::Ok;
}

static bool validWorkspace(const char *workspace) {
  if (std::strlen(workspace) != 64) return false;
  for (std::size_t i = 0; i < 64; ++i)
    if (!((workspace[i] >= '0' && workspace[i] <= '9') ||
          (workspace[i] >= 'a' && workspace[i] <= 'f'))) return false;
  return true;
}

static bool validSdkToken(const char *token, const char *workspace) {
  const char *parts = nullptr;
  if (std::strncmp(token, "ol_sdk_", 7) == 0) parts = token + 7;
  else if (std::strncmp(token, "ol_agent_", 9) == 0) parts = token + 9;
  else return false;
  if (std::strlen(parts) != 129 || parts[64] != '_' ||
      std::strncmp(parts, workspace, 64) != 0) return false;
  for (std::size_t i = 65; i < 129; ++i)
    if (!((parts[i] >= '0' && parts[i] <= '9') ||
          (parts[i] >= 'a' && parts[i] <= 'f'))) return false;
  return true;
}

static bool validRequestId(const char *requestId) {
  if (std::strlen(requestId) != 36) return false;
  for (std::size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (requestId[i] != '-') return false;
    } else if (!((requestId[i] >= '0' && requestId[i] <= '9') ||
                 (requestId[i] >= 'a' && requestId[i] <= 'f'))) return false;
  }
  return true;
}

static bool validHost(const char *host) {
  const std::size_t length = std::strlen(host);
  if (length == 0 || length >= sizeof(cfg.host)) return false;
  for (std::size_t i = 0; i < length; ++i)
    if (!(std::isalnum(static_cast<unsigned char>(host[i])) ||
          host[i] == '.' || host[i] == '-')) return false;
  return true;
}

static bool configureFromCommand(JsonVariantConst input) {
  if (storageFault) { emitError("eeprom_reset_required"); return false; }
  if (paired) { emitError("already_paired_reset_required"); return false; }
  if (configured) { emitError("already_configured_reset_required"); return false; }
  Config candidate{};
  if (!safeCopy(candidate.ssid, sizeof(candidate.ssid), input["ssid"]) ||
      !safeCopy(candidate.password, sizeof(candidate.password), input["password"]) ||
      !safeCopy(candidate.host, sizeof(candidate.host), input["host"]) ||
      !safeCopy(candidate.workspace, sizeof(candidate.workspace), input["workspace"]) ||
      !safeCopy(candidate.bootstrapToken, sizeof(candidate.bootstrapToken), input["token"]) ||
      !safeCopy(candidate.requestId, sizeof(candidate.requestId), input["requestId"]) ||
      !candidate.ssid[0] || !validHost(candidate.host) ||
      !validWorkspace(candidate.workspace)) {
    emitError("invalid_configuration");
    return false;
  }
  const char *mode = input["mode"] | "";
  if (std::strcmp(mode, "sdk") == 0) {
    if (!validSdkToken(candidate.bootstrapToken, candidate.workspace) ||
        !validRequestId(candidate.requestId) ||
        !input["requestCreatedAtMs"].is<std::uint64_t>()) {
      emitError("invalid_configuration");
      return false;
    }
    candidate.bootstrapMode = kBootstrapSdk;
    candidate.requestCreatedAtMs = input["requestCreatedAtMs"].as<std::uint64_t>();
    if (candidate.requestCreatedAtMs == 0) { emitError("invalid_configuration"); return false; }
  } else if (std::strcmp(mode, "enrollment") == 0) {
    if (std::strlen(candidate.bootstrapToken) != 64) {
      emitError("invalid_configuration");
      return false;
    }
    candidate.bootstrapMode = kBootstrapEnrollment;
  } else {
    emitError("invalid_configuration");
    return false;
  }

  cfg = candidate;
  configured = true;
  provisioningStopped = false;
  if (cfg.bootstrapMode == kBootstrapSdk && !saveConfigAndVerify()) {
    configured = false;
    emitError("config_storage_failed");
    return false;
  }
  emitEvent("configured");
  return true;
}

static void resetDevice() {
  if (!fullJournalFits()) { emitError("eeprom_size_unsupported"); return; }
  cfg = Config{};
  EEPROM.put(0, cfg);
  Config verify{};
  EEPROM.get(0, verify);
  if (verify.magic != 0) { emitError("reset_failed"); return; }
  OpenLaunchResultRecord empty{};
  // Reset is the explicit operator path for clearing even an uncertain record.
  ArduinoEepromJournalStorage{}.writeBlock(sizeof(Config), &empty, sizeof(empty));
  OpenLaunchResultRecord journalVerify{};
  ArduinoEepromJournalStorage{}.readBlock(sizeof(Config), &journalVerify, sizeof(journalVerify));
  if (!openLaunchRecordEmpty(journalVerify)) { emitError("reset_failed"); return; }
  configured = paired = provisioningStopped = false;
  storageFault = false;
  actionUncertain = resultHalted = false;
  resultJournalState = OpenLaunchJournalState::Empty;
  pendingResultRecord = OpenLaunchResultRecord{};
  WiFi.disconnect();
  emitEvent("reset");
}

static void loadResultJournal() {
  resultJournalState = resultJournal.load(pendingResultRecord);
  if (resultJournalState == OpenLaunchJournalState::NoSpace ||
      resultJournalState == OpenLaunchJournalState::Invalid) {
    storageFault = true;
    resultHalted = true;
    return;
  }
  if (resultJournalState == OpenLaunchJournalState::Intent) {
    actionUncertain = true;
    resultHalted = true;
    provisioningStopped = true;
  } else if (resultJournalState == OpenLaunchJournalState::Saved) {
    provisioningStopped = true;
  } else if (resultJournalState == OpenLaunchJournalState::Halted) {
    provisioningStopped = true;
    resultHalted = true;
  }
}

static void maintainWifiConnection() {
  if (!configured || WiFi.status() == WL_CONNECTED) return;
  if (lastWifiAttempt == 0 || millis() - lastWifiAttempt >= 10000UL) {
    lastWifiAttempt = millis();
    if (cfg.password[0]) WiFi.begin(cfg.ssid, cfg.password);
    else WiFi.begin(cfg.ssid);
  }
}

static bool resultRetryDue() {
  return !resultRetryScheduled ||
      static_cast<long>(millis() - resultRetryAt) >= 0;
}

static void scheduleResultRetry(unsigned long delayMs) {
  resultRetryAt = millis() + delayMs;
  resultRetryScheduled = true;
}

static void processSerialLine() {
  JsonDocument input;
  if (deserializeJson(input, serialLine, serialLineLength) || !input.is<JsonObjectConst>()) {
    emitError("invalid_json");
    return;
  }
  const char *command = input["command"] | "";
  if (std::strcmp(command, "status") == 0) emitStatus();
  else if (std::strcmp(command, "configure") == 0)
    configureFromCommand(input.as<JsonVariantConst>());
  else if (std::strcmp(command, "reset") == 0) resetDevice();
  else emitError("unknown_command");
}

static void serviceSerial() {
  while (Serial.available()) {
    const int next = Serial.read();
    if (next < 0) return;
    const char value = static_cast<char>(next);
    if (value == '\n') {
      if (serialLineOverflow) emitError("line_too_large");
      else {
        serialLine[serialLineLength] = '\0';
        processSerialLine();
      }
      serialLineLength = 0;
      serialLineOverflow = false;
    } else if (value != '\r') {
      if (serialLineLength < kSerialLineLimit)
        serialLine[serialLineLength++] = value;
      else
        serialLineOverflow = true;
    }
  }
}

static JsonDocument makeManifestRequest(bool sdkAttach) {
  JsonDocument request;
  JsonObject manifest = request["manifest"].to<JsonObject>();
  manifest["name"] = "uno-r4-wifi";
  manifest["kind"] = "uno-r4-wifi";
  JsonArray capabilities = manifest["capabilities"].to<JsonArray>();
  capabilities.add("device.health");
  capabilities.add("led.set");
  capabilities.add("display.text");
  if (sdkAttach) request["requestId"] = cfg.requestId;
  else request["token"] = cfg.bootstrapToken;
  return request;
}

static bool persistChildIdentity(JsonVariantConst data) {
  char deviceId[sizeof(cfg.deviceId)]{};
  char childToken[sizeof(cfg.token)]{};
  if (!safeCopy(deviceId, sizeof(deviceId), data["deviceId"]) ||
      !safeCopy(childToken, sizeof(childToken), data["token"]) ||
      std::strlen(deviceId) != 36 || std::strlen(childToken) != 64)
    return false;
  std::strcpy(cfg.deviceId, deviceId);
  std::strcpy(cfg.token, childToken);
  if (!saveConfigAndVerify()) return false;
  Config verify{};
  EEPROM.get(0, verify);
  if (verify.magic != kMagicV2 ||
      std::strcmp(verify.deviceId, deviceId) != 0 ||
      std::strcmp(verify.token, childToken) != 0)
    return false;
  paired = true;
  return true;
}

static void attemptProvisioning() {
  if (!configured || paired || provisioningStopped ||
      !cfg.bootstrapToken[0] || WiFi.status() != WL_CONNECTED)
    return;
  const bool sdkAttach = cfg.bootstrapMode == kBootstrapSdk;
  if (sdkAttach) {
    const unsigned long epoch = WiFi.getTime();
    if (epoch < 1700000000UL) return;
    const std::uint64_t nowMs = static_cast<std::uint64_t>(epoch) * 1000ULL;
    const auto clock = openLaunchAttachmentClock(
        nowMs, cfg.requestCreatedAtMs, kSdkAttachmentWindowMs);
    if (clock == OpenLaunchAttachmentClock::Waiting) return;
    if (clock == OpenLaunchAttachmentClock::Expired) {
      emitError("sdk_attachment_window_expired_reprovision");
      provisioningStopped = true;
      return;
    }
    if (millis() - lastAttachAttempt < 15000UL) return;
    lastAttachAttempt = millis();
  } else if (lastAttachAttempt != 0) {
    return;
  } else {
    lastAttachAttempt = millis();
  }

  JsonDocument request = makeManifestRequest(sdkAttach);
  JsonDocument response;
  const HttpResult result = post(sdkAttach ? "/v1/sdk/devices" : "/v1/device/enroll",
                                 request, response,
                                 sdkAttach ? cfg.bootstrapToken : nullptr);
  if (result != HttpResult::Ok) {
    if (!sdkAttach) {
      emitError("enrollment_outcome_ambiguous_check_console");
      provisioningStopped = true;
      return;
    }
    if (result == HttpResult::HttpError && lastHttpStatusCode >= 400 &&
        lastHttpStatusCode < 500 && lastHttpStatusCode != 429) {
      emitError("sdk_attachment_rejected_check_token_and_console");
      provisioningStopped = true;
    }
    return;
  }
  if (!persistChildIdentity(response["data"])) {
    emitError("identity_persistence_failed_check_console");
    provisioningStopped = true;
    return;
  }
  const bool cleared = clearBootstrapCredential();
  emitPaired(cleared);
}

static void serviceDevice() {
  if (storageFault || actionUncertain || resultHalted) return;
  maintainWifiConnection();
  if (resultJournalState == OpenLaunchJournalState::Intent) return;
  if (resultJournalState == OpenLaunchJournalState::Saved) {
    if (!configured || !paired || WiFi.status() != WL_CONNECTED ||
        !resultRetryDue()) return;
    const unsigned long epoch = WiFi.getTime();
    if (epoch < 1700000000UL) {
      scheduleResultRetry(10000UL);
      return;
    }
    if (openLaunchResultExpired(pendingResultRecord,
            static_cast<std::uint64_t>(epoch) * 1000ULL)) {
      resultHalted = true;
      provisioningStopped = true;
      if (resultJournal.halt(pendingResultRecord.actionId))
        resultJournalState = OpenLaunchJournalState::Halted;
      else
        storageFault = true;
      emitError("pending_result_expired_outcome_uncertain");
      return;
    }
    JsonDocument ack, reply;
    if (deserializeJson(ack, pendingResultRecord.payload,
                        pendingResultRecord.payloadLength) ||
        std::strcmp(ack["actionId"] | "", pendingResultRecord.actionId) != 0 ||
        !ack["status"].is<const char *>() ||
        !ack["result"].is<JsonObjectConst>()) {
      storageFault = true;
      return;
    }
    const char *ackStatus = ack["status"].as<const char *>();
    if (std::strcmp(ackStatus, "succeeded") != 0 &&
        std::strcmp(ackStatus, "failed") != 0) {
      storageFault = true;
      return;
    }
    const String resultPath = String("/v1/device/") + cfg.deviceId + "/result";
    const HttpResult uploaded = post(resultPath, ack, reply);
    if (uploaded != HttpResult::Ok) {
      if (uploaded == HttpResult::HttpError && lastHttpStatusCode >= 400 &&
          lastHttpStatusCode < 500 && lastHttpStatusCode != 429 &&
          lastHttpStatusCode != 408) {
        resultHalted = true;
        provisioningStopped = true;
        if (resultJournal.halt(pendingResultRecord.actionId))
          resultJournalState = OpenLaunchJournalState::Halted;
        else
          storageFault = true;
        emitError("pending_result_rejected_inspect_console");
      } else {
        scheduleResultRetry(resultRetryDelayMs);
        resultRetryDelayMs = resultRetryDelayMs < 30000UL
            ? resultRetryDelayMs * 2UL : 60000UL;
      }
      return;
    }
    JsonObjectConst accepted = reply["data"].as<JsonObjectConst>();
    String expectedResult, acceptedResult;
    serializeJson(ack["result"], expectedResult);
    serializeJson(accepted["result"], acceptedResult);
    const bool matches =
        std::strcmp(accepted["id"] | "", pendingResultRecord.actionId) == 0 &&
        std::strcmp(accepted["status"] | "", ackStatus) == 0 &&
        expectedResult == acceptedResult;
    if (!matches) {
      resultHalted = true;
      provisioningStopped = true;
      if (resultJournal.halt(pendingResultRecord.actionId))
        resultJournalState = OpenLaunchJournalState::Halted;
      else
        storageFault = true;
      emitError("pending_result_ack_mismatch_retained");
      return;
    }
    if (!resultJournal.clearMatching(pendingResultRecord.actionId,
                                     pendingResultRecord.payload,
                                     pendingResultRecord.payloadLength)) {
      storageFault = true;
      return;
    }
    resultJournalState = OpenLaunchJournalState::Empty;
    pendingResultRecord = OpenLaunchResultRecord{};
    resultRetryDelayMs = 3000UL;
    resultRetryScheduled = false;
    return;
  }

  if (!configured || provisioningStopped) return;
  if (paired && cfg.bootstrapToken[0] &&
      millis() - lastBootstrapCleanupAttempt >= 5000UL) {
    lastBootstrapCleanupAttempt = millis();
    clearBootstrapCredential();
  }
  if (WiFi.status() != WL_CONNECTED) return;
  if (!paired) {
    attemptProvisioning();
    return;
  }
  if (millis() - lastPoll < 10000UL) return;
  lastPoll = millis();
  JsonDocument request, response;
  const String nextPath = String("/v1/device/") + cfg.deviceId + "/next";
  if (post(nextPath, request, response) != HttpResult::Ok || response["data"].isNull())
    return;
  JsonObjectConst cmd = response["data"].as<JsonObjectConst>();
  const char *id = cmd["id"] | "";
  if (!openLaunchValidActionId(id) || !cmd["expiresAt"].is<std::uint64_t>()) return;
  const std::uint64_t expiresAt = cmd["expiresAt"].as<std::uint64_t>();
  if (expiresAt == 0 || !resultJournal.begin(id, expiresAt)) {
    storageFault = true;
    provisioningStopped = true;
    emitError("result_journal_write_failed_action_not_run");
    return;
  }
  resultJournalState = OpenLaunchJournalState::Intent;
  if (resultJournal.load(pendingResultRecord) != OpenLaunchJournalState::Intent) {
    storageFault = true;
    provisioningStopped = true;
    emitError("result_journal_readback_failed_action_not_run");
    return;
  }

  JsonDocument ack;
  ack["actionId"] = id;
  ack["status"] = "failed";
  const unsigned long epoch = WiFi.getTime();
  if (epoch < 1700000000UL ||
      (static_cast<std::uint64_t>(epoch) * 1000ULL) >= expiresAt) {
    ack["result"]["error"] = "clock_unavailable_or_expired";
  } else {
    const char *capability = cmd["capability"] | "";
    if (std::strcmp(capability, "device.health") == 0) {
      ack["status"] = "succeeded";
      ack["result"]["uptimeMs"] = millis();
      ack["result"]["rssi"] = WiFi.RSSI();
      ack["result"]["board"] = "uno-r4-wifi";
    } else if (std::strcmp(capability, "led.set") == 0 && cmd["args"]["on"].is<bool>()) {
      const bool on = cmd["args"]["on"].as<bool>();
      digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
      ack["status"] = "succeeded";
      ack["result"]["on"] = on;
    } else if (std::strcmp(capability, "display.text") == 0) {
      const char *text = cmd["args"]["text"] | "";
      bool valid = std::strlen(text) <= 96;
      for (std::size_t i = 0; i < std::strlen(text); ++i)
        if (text[i] < 32 || text[i] > 126) valid = false;
      if (valid) {
        matrix.beginDraw();
        matrix.stroke(0xFFFFFFFF);
        matrix.textFont(Font_5x7);
        matrix.textScrollSpeed(50);
        matrix.beginText(0, 1, 0xFFFFFF);
        matrix.print(text);
        matrix.endText(SCROLL_LEFT);
        matrix.endDraw();
        ack["status"] = "succeeded";
        ack["result"]["text"] = text;
      } else {
        ack["result"]["error"] = "ascii_text_required";
      }
    } else {
      ack["result"]["error"] = "unsupported_capability";
    }
  }
  String serializedAck;
  serializeJson(ack, serializedAck);
  if (!resultJournal.saveOutcome(id, expiresAt, serializedAck.c_str(),
                                 serializedAck.length())) {
    actionUncertain = true;
    resultHalted = true;
    resultJournalState = resultJournal.load(pendingResultRecord);
    if (resultJournalState == OpenLaunchJournalState::Invalid ||
        resultJournalState == OpenLaunchJournalState::NoSpace)
      storageFault = true;
    emitError("action_outcome_persistence_failed_uncertain");
    return;
  }
  resultJournalState = resultJournal.load(pendingResultRecord);
  if (resultJournalState != OpenLaunchJournalState::Saved) {
    storageFault = true;
    resultHalted = true;
    return;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  matrix.begin();
  if (!migrateOrLoadConfig()) storageFault = true;
  loadResultJournal();
  if (configured) WiFi.begin(cfg.ssid, cfg.password);
}

void loop() {
  serviceSerial();
  serviceDevice();
  delay(10);
}
