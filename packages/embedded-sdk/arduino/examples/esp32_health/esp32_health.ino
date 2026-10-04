#include <WiFi.h>
#include <openlaunch.h>

#include <memory>
#include <new>
#include <time.h>

// Credentials and the trusted CA arrive over the bounded USB serial protocol;
// no network secrets or certificate are compiled into this sketch.
constexpr std::size_t kSerialLineLimit = 8192;
char serialLine[kSerialLineLimit + 1]{};
std::size_t serialLineLength = 0;
bool serialLineOverflow = false;

openlaunch::Esp32ProvisioningConfig provisioning;
openlaunch::WorkspaceId workspace;
openlaunch::Esp32Clock clockSource;
openlaunch::Esp32Preferences storage;
std::unique_ptr<openlaunch::Esp32HttpTransport> transport;
std::unique_ptr<openlaunch::DeviceClient> device;
openlaunch::Action currentAction;
openlaunch::ResultReport pendingResult;

bool storageReady = false;
bool configured = false;
bool paired = false;
bool wifiStarted = false;
bool timeConfigured = false;
bool hasPendingResult = false;
bool pendingExpiryReported = false;
bool operatorStop = false;
bool enrollmentStopped = false;
unsigned long lastWifiAttempt = 0;
unsigned long lastEnrollAttempt = 0;
unsigned long lastPoll = 0;
unsigned long lastResultRetry = 0;
unsigned long lastBootstrapCleanupAttempt = 0;

static void event(const char *kind, const char *state = nullptr) {
  Serial.print("{\"event\":\"");
  Serial.print(kind);
  Serial.print("\"");
  if (state) {
    Serial.print(",\"state\":\"");
    Serial.print(state);
    Serial.print("\"");
  }
  Serial.println("}");
}

static void errorEvent(const char *code) {
  Serial.print("{\"event\":\"error\",\"code\":\"");
  Serial.print(code);
  Serial.println("\"}");
}

static void pairedEvent(bool bootstrapCredentialCleared) {
  Serial.print("{\"event\":\"paired\",\"state\":\"paired\",\"bootstrapCredentialCleared\":");
  Serial.print(bootstrapCredentialCleared ? "true" : "false");
  Serial.println("}");
}

static bool readField(char *out, std::size_t capacity, JsonVariantConst field) {
  const char *value = field.as<const char *>();
  if (!value || std::strlen(value) >= capacity) return false;
  std::strcpy(out, value);
  return true;
}

static void printStatus() {
  if (!storageReady) { errorEvent("storage_unavailable"); return; }
  openlaunch::Identity savedIdentity;
  openlaunch::Esp32ProvisioningConfig savedConfig;
  const auto identityState = storage.loadIdentity(savedIdentity);
  const auto configState = storage.loadProvisioningConfig(savedConfig);
  if (identityState == openlaunch::Persistence::ReadStatus::Error ||
      configState == openlaunch::Persistence::ReadStatus::Error) {
    errorEvent("storage_error");
    return;
  }
  const char *state = identityState == openlaunch::Persistence::ReadStatus::Found
      ? "paired"
      : configState == openlaunch::Persistence::ReadStatus::Found ? "configured" : "unconfigured";
  const auto pendingState = storage.loadPendingResult(pendingResult);
  if (pendingState == openlaunch::Persistence::ReadStatus::Error) {
    errorEvent("pending_result_storage_error");
    return;
  }
  hasPendingResult = pendingState == openlaunch::Persistence::ReadStatus::Found;
  Serial.print("{\"event\":\"status\",\"state\":\"");
  Serial.print(state);
  Serial.print("\",\"pendingResult\":");
  Serial.print(hasPendingResult ? "true" : "false");
  Serial.println("}");
}

static bool initializeDevice() {
  if (!configured || !workspace.set(provisioning.workspace.value)) return false;
  transport.reset(new (std::nothrow) openlaunch::Esp32HttpTransport(
      provisioning.origin.value, provisioning.workspace.value, provisioning.rootCa.value));
  if (!transport || !transport->ready()) return false;
  device.reset(new (std::nothrow) openlaunch::DeviceClient(
      *transport, clockSource, storage, workspace));
  if (!device) return false;
  const auto resume = device->resume();
  if (resume == openlaunch::Status::Ok) {
    paired = true;
    clearBootstrapCredential();
  } else if (resume == openlaunch::Status::NotPaired) {
    paired = false;
  } else {
    return false;
  }
  const auto pending = storage.loadPendingResult(pendingResult);
  if (pending == openlaunch::Persistence::ReadStatus::Error) return false;
  hasPendingResult = pending == openlaunch::Persistence::ReadStatus::Found;
  return true;
}

static bool clearBootstrapCredential() {
  bool cleared = true;
  if (!provisioning.enrollmentToken.empty())
    cleared = storage.clearEnrollmentToken() && cleared;
  if (!provisioning.sdkToken.empty())
    cleared = storage.clearSdkToken() && cleared;
  if (cleared) {
    provisioning.enrollmentToken.value[0] = '\0';
    provisioning.sdkToken.value[0] = '\0';
  }
  return cleared;
}

static bool configureFromCommand(JsonVariantConst input) {
  if (!storageReady) { errorEvent("storage_unavailable"); return false; }
  openlaunch::Identity savedIdentity;
  const auto identityState = storage.loadIdentity(savedIdentity);
  if (identityState == openlaunch::Persistence::ReadStatus::Found) {
    errorEvent("already_paired");
    return false;
  }
  if (identityState == openlaunch::Persistence::ReadStatus::Error) {
    errorEvent("storage_error");
    return false;
  }
  provisioning = openlaunch::Esp32ProvisioningConfig{};
  if (!readField(provisioning.ssid.value, sizeof(provisioning.ssid.value), input["ssid"]) ||
      !readField(provisioning.password.value, sizeof(provisioning.password.value), input["password"]) ||
      !readField(provisioning.origin.value, sizeof(provisioning.origin.value), input["url"]) ||
      !readField(provisioning.workspace.value, sizeof(provisioning.workspace.value), input["workspace"]) ||
      !readField(provisioning.enrollmentToken.value, sizeof(provisioning.enrollmentToken.value), input["enrollmentToken"]) ||
      !readField(provisioning.sdkToken.value, sizeof(provisioning.sdkToken.value), input["sdkToken"]) ||
      !readField(provisioning.requestId.value, sizeof(provisioning.requestId.value), input["requestId"]) ||
      !readField(provisioning.rootCa.value, sizeof(provisioning.rootCa.value), input["rootCa"]) ||
      (!input["requestCreatedAtMs"].is<std::uint64_t>() &&
       !provisioning.sdkToken.empty())) {
    errorEvent("invalid_configuration");
    return false;
  }
  if (!provisioning.sdkToken.empty())
    provisioning.requestCreatedAtMs = input["requestCreatedAtMs"].as<std::uint64_t>();
  if (!storage.saveProvisioningConfig(provisioning)) {
    errorEvent("invalid_configuration");
    return false;
  }
  configured = true;
  paired = false;
  wifiStarted = false;
  timeConfigured = false;
  operatorStop = false;
  enrollmentStopped = false;
  if (!initializeDevice()) {
    errorEvent("device_initialization_failed");
    return false;
  }
  event("configured", "configured");
  return true;
}

static void resetDevice() {
  if (!storageReady || !storage.resetAll()) { errorEvent("reset_failed"); return; }
  WiFi.disconnect(true, true);
  provisioning = openlaunch::Esp32ProvisioningConfig{};
  workspace = openlaunch::WorkspaceId{};
  device.reset();
  transport.reset();
  configured = paired = wifiStarted = timeConfigured = hasPendingResult = false;
  pendingExpiryReported = operatorStop = enrollmentStopped = false;
  event("reset", "unconfigured");
}

static void discardPendingResult() {
  if (!device) { errorEvent("not_paired"); return; }
  const auto status = device->discardPendingResult();
  if (status == openlaunch::Status::Ok || status == openlaunch::Status::NoAction) {
    hasPendingResult = false;
    pendingExpiryReported = false;
    event("pending_result_discarded");
  } else {
    errorEvent("pending_result_discard_failed");
  }
}

static void processSerialLine() {
  JsonDocument command;
  if (deserializeJson(command, serialLine, serialLineLength) ||
      !command.is<JsonObjectConst>()) {
    errorEvent("invalid_json");
    return;
  }
  const char *name = command["command"].as<const char *>();
  if (!name) { errorEvent("missing_command"); return; }
  if (std::strcmp(name, "status") == 0) printStatus();
  else if (std::strcmp(name, "configure") == 0) configureFromCommand(command.as<JsonVariantConst>());
  else if (std::strcmp(name, "reset") == 0) resetDevice();
  else if (std::strcmp(name, "discard_pending_result") == 0) discardPendingResult();
  else errorEvent("unknown_command");
}

static void serviceSerial() {
  while (Serial.available()) {
    const int next = Serial.read();
    if (next < 0) return;
    const char value = static_cast<char>(next);
    if (value == '\n') {
      if (serialLineOverflow) errorEvent("line_too_large");
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

static void tryEnroll() {
  if (!device || paired || enrollmentStopped ||
      (provisioning.enrollmentToken.empty() && provisioning.sdkToken.empty()) ||
      WiFi.status() != WL_CONNECTED || millis() - lastEnrollAttempt < 15000) return;
  if (!provisioning.sdkToken.empty()) {
    std::uint64_t now = 0;
    if (!clockSource.unixTimeMs(now)) return;
    constexpr std::uint64_t kSafeAttachRetryWindowMs = 9ULL * 60ULL * 1000ULL;
    if (now < provisioning.requestCreatedAtMs ||
        now - provisioning.requestCreatedAtMs > kSafeAttachRetryWindowMs) {
      errorEvent("sdk_attachment_window_expired_reprovision");
      enrollmentStopped = true;
      return;
    }
  }
  lastEnrollAttempt = millis();
  std::unique_ptr<openlaunch::Manifest> manifest(new (std::nothrow) openlaunch::Manifest());
  if (!manifest) { errorEvent("allocation_failed"); enrollmentStopped = true; return; }
  manifest->name.set("ESP32 health example");
  manifest->kind.set("custom.device");
  manifest->capabilities[0].set("device.health");
  manifest->capabilityCount = 1;
  const auto result = provisioning.sdkToken.empty()
      ? device->enroll(provisioning.enrollmentToken, *manifest)
      : device->attachSdkToken(provisioning.sdkToken, provisioning.requestId, *manifest);
  if (result == openlaunch::Status::Ok) {
    paired = true;
    openlaunch::Identity durableIdentity;
    const auto durable = storage.loadIdentity(durableIdentity);
    if (durable != openlaunch::Persistence::ReadStatus::Found ||
        durableIdentity.deviceId.empty() || durableIdentity.credential.empty()) {
      errorEvent("identity_persistence_verification_failed");
      enrollmentStopped = true;
      return;
    }
    const bool tokenCleared = clearBootstrapCredential();
    pairedEvent(tokenCleared);
  } else if (result == openlaunch::Status::TransportError ||
             result == openlaunch::Status::StorageError) {
    errorEvent("enrollment_failed_check_console_before_retry");
    enrollmentStopped = true;
  } else {
    errorEvent("enrollment_failed");
    enrollmentStopped = true;
  }
}

static bool nonRetryableHttpError() {
  const int code = transport ? transport->lastHttpStatusCode() : 0;
  return code >= 400 && code < 500 && code != 429;
}

static void serviceDevice() {
  if (!configured || !device || operatorStop) return;
  if (WiFi.status() != WL_CONNECTED) {
    if (!wifiStarted || millis() - lastWifiAttempt >= 10000) {
      lastWifiAttempt = millis();
      wifiStarted = true;
      if (provisioning.password.empty()) WiFi.begin(provisioning.ssid.value);
      else WiFi.begin(provisioning.ssid.value, provisioning.password.value);
    }
    return;
  }
  if (!timeConfigured) {
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    timeConfigured = true;
  }
  if (paired && (!provisioning.enrollmentToken.empty() || !provisioning.sdkToken.empty()) &&
      millis() - lastBootstrapCleanupAttempt >= 5000) {
    lastBootstrapCleanupAttempt = millis();
    clearBootstrapCredential();
  }
  if (!paired) { tryEnroll(); return; }

  if (hasPendingResult) {
    if (millis() - lastResultRetry < 1000) return;
    lastResultRetry = millis();
    const auto retry = device->retryResult();
    if (retry == openlaunch::Status::Ok || retry == openlaunch::Status::NoAction) {
      hasPendingResult = false;
      pendingExpiryReported = false;
    } else if (retry == openlaunch::Status::Expired && !pendingExpiryReported) {
      errorEvent("pending_result_expired_operator_review_required");
      pendingExpiryReported = true;
    } else if (retry == openlaunch::Status::TransportError && nonRetryableHttpError()) {
      errorEvent("result_http_error_operator_review_required");
      operatorStop = true;
    }
    return;
  }

  if (millis() - lastPoll < 10000) return;
  lastPoll = millis();
  const auto next = device->nextAction(currentAction);
  if (next == openlaunch::Status::TransportError && nonRetryableHttpError()) {
    errorEvent("poll_http_error_operator_review_required");
    operatorStop = true;
    return;
  }
  if (next != openlaunch::Status::Ok) return;

  char result[128];
  openlaunch::ResultStatus resultStatus = openlaunch::ResultStatus::Failed;
  if (std::strcmp(currentAction.capability.value, "device.health") == 0) {
    std::snprintf(result, sizeof(result), "{\"board\":\"esp32\",\"uptimeMs\":%lu,\"rssi\":%d}",
                  static_cast<unsigned long>(millis()), WiFi.RSSI());
    resultStatus = openlaunch::ResultStatus::Succeeded;
  } else {
    std::strncpy(result, "{\"error\":\"unsupported_capability\"}", sizeof(result));
    result[sizeof(result) - 1] = '\0';
  }
  const auto report = device->reportResult(currentAction, resultStatus, result);
  if (report == openlaunch::Status::TransportError) {
    hasPendingResult = true;
    lastResultRetry = millis();
    if (nonRetryableHttpError()) {
      errorEvent("result_http_error_operator_review_required");
      operatorStop = true;
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  storageReady = storage.begin();
  if (!storageReady) return;
  const auto stored = storage.loadProvisioningConfig(provisioning);
  if (stored == openlaunch::Persistence::ReadStatus::Found) {
    configured = true;
    if (!initializeDevice()) errorEvent("stored_config_initialization_failed");
  } else if (stored == openlaunch::Persistence::ReadStatus::Error) {
    errorEvent("stored_config_error");
  }
}

void loop() {
  serviceSerial();
  serviceDevice();
  delay(10);
}
