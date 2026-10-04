#pragma once

#include "../../../include/openlaunch/embedded.hpp"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>

#include <ctime>
#include <memory>
#include <new>

namespace openlaunch {

constexpr std::size_t kEsp32RootCaSize = 4097;
constexpr std::size_t kEsp32OriginSize = 256;

struct Esp32ProvisioningConfig {
  Text<33> ssid;
  Text<65> password;
  Text<kEsp32OriginSize> origin;
  WorkspaceId workspace;
  EnrollmentToken enrollmentToken;
  SdkToken sdkToken;
  RequestId requestId;
  std::uint64_t requestCreatedAtMs = 0;
  Text<kEsp32RootCaSize> rootCa;
};

class Esp32Clock final : public Clock {
 public:
  bool unixTimeMs(std::uint64_t &out) const override {
    const std::time_t seconds = std::time(nullptr);
    // Match the firmware's fail-closed threshold for an unset ESP32 clock.
    if (seconds < 1700000000) return false;
    out = static_cast<std::uint64_t>(seconds) * 1000ULL;
    return true;
  }
};

// NVS values are not encrypted by this class. ESP32 flash encryption/NVS
// encryption must be enabled and provisioned separately when at-rest secrecy
// is required. Never print these values.
class Esp32Preferences final : public Persistence {
 public:
  bool begin() {
    if (!preferences_.begin("openlaunch", false)) return false;
    if (!configPreferences_.begin("olnetcfg", false)) {
      preferences_.end();
      return false;
    }
    ready_ = true;
    return true;
  }
  void end() {
    if (ready_) {
      preferences_.end();
      configPreferences_.end();
    }
    ready_ = false;
  }

  ReadStatus loadIdentity(Identity &out) override {
    if (!ready_) return ReadStatus::Error;
    if (!preferences_.isKey("identity")) return ReadStatus::Empty;
    if (preferences_.getBytesLength("identity") != sizeof(out) ||
        preferences_.getBytes("identity", &out, sizeof(out)) != sizeof(out))
      return ReadStatus::Error;
    if (out.deviceId.empty() || out.credential.empty()) return ReadStatus::Error;
    return ReadStatus::Found;
  }

  bool saveIdentity(const Identity &value) override {
    if (!ready_ || value.deviceId.empty() || value.credential.empty() ||
        preferences_.isKey("identity")) return false;
    return preferences_.putBytes("identity", &value, sizeof(value)) == sizeof(value);
  }

  ReadStatus loadPendingResult(ResultReport &out) override {
    if (!ready_) return ReadStatus::Error;
    if (!preferences_.isKey("pending")) return ReadStatus::Empty;
    PendingBlob blob{};
    if (preferences_.getBytesLength("pending") != sizeof(blob) ||
        preferences_.getBytes("pending", &blob, sizeof(blob)) != sizeof(blob) ||
        blob.magic != kPendingMagic) return ReadStatus::Error;
    out = blob.report;
    if (out.actionId.empty() || out.resultJson.empty() || out.expiresAtMs == 0)
      return ReadStatus::Error;
    return ReadStatus::Found;
  }

  bool savePendingResult(const ResultReport &value) override {
    if (!ready_ || value.actionId.empty() || value.resultJson.empty() ||
        value.expiresAtMs == 0 || preferences_.isKey("pending")) return false;
    PendingBlob blob{};
    blob.magic = kPendingMagic;
    blob.report = value;
    return preferences_.putBytes("pending", &blob, sizeof(blob)) == sizeof(blob);
  }

  bool clearPendingResult() override {
    if (!ready_) return false;
    return !preferences_.isKey("pending") || preferences_.remove("pending");
  }

  ReadStatus loadProvisioningConfig(Esp32ProvisioningConfig &out) {
    if (!ready_) return ReadStatus::Error;
    if (!configPreferences_.isKey("network")) return ReadStatus::Empty;
    ProvisioningBlob blob{};
    if (configPreferences_.getBytesLength("network") != sizeof(blob) ||
        configPreferences_.getBytes("network", &blob, sizeof(blob)) != sizeof(blob) ||
        blob.magic != kProvisioningMagic || !validConfig(blob.config))
      return ReadStatus::Error;
    out = blob.config;
    return ReadStatus::Found;
  }

  // Network configuration is stored in the separate `olnetcfg` NVS namespace.
  // A paired identity blocks replacement; resetAll() is the explicit erase path.
  bool saveProvisioningConfig(const Esp32ProvisioningConfig &value) {
    if (!ready_ || preferences_.isKey("identity") || !validConfig(value) ||
        (value.enrollmentToken.empty() == value.sdkToken.empty()) ||
        (!value.enrollmentToken.empty() && !lowerHex(value.enrollmentToken.value, 64))) return false;
    ProvisioningBlob blob{};
    blob.magic = kProvisioningMagic;
    blob.config = value;
    return configPreferences_.putBytes("network", &blob, sizeof(blob)) == sizeof(blob);
  }

  bool clearEnrollmentToken() {
    Esp32ProvisioningConfig config;
    if (loadProvisioningConfig(config) != ReadStatus::Found) return false;
    config.enrollmentToken.value[0] = '\0';
    ProvisioningBlob blob{};
    blob.magic = kProvisioningMagic;
    blob.config = config;
    return configPreferences_.putBytes("network", &blob, sizeof(blob)) == sizeof(blob);
  }

  bool clearSdkToken() {
    Esp32ProvisioningConfig config;
    if (loadProvisioningConfig(config) != ReadStatus::Found) return false;
    config.sdkToken.value[0] = '\0';
    ProvisioningBlob blob{};
    blob.magic = kProvisioningMagic;
    blob.config = config;
    return configPreferences_.putBytes("network", &blob, sizeof(blob)) == sizeof(blob);
  }

  bool resetAll() {
    if (!ready_) return false;
    const bool configOk = configPreferences_.clear();
    const bool identityOk = preferences_.clear();
    return configOk && identityOk;
  }

 private:
  struct PendingBlob {
    std::uint32_t magic;
    ResultReport report;
  };
  struct ProvisioningBlob {
    std::uint32_t magic;
    Esp32ProvisioningConfig config;
  };
  static constexpr std::uint32_t kPendingMagic = 0x4F4C5253;
  static constexpr std::uint32_t kProvisioningMagic = 0x4F4C4346;

  static bool lowerHex(const char *text, std::size_t length) {
    if (std::strlen(text) != length) return false;
    for (std::size_t i = 0; i < length; ++i)
      if (!((text[i] >= '0' && text[i] <= '9') ||
            (text[i] >= 'a' && text[i] <= 'f'))) return false;
    return true;
  }

  static bool validConfig(const Esp32ProvisioningConfig &config) {
    if (config.ssid.empty() || std::strlen(config.ssid.value) > 32 ||
        std::strlen(config.password.value) > 64 || config.origin.empty() ||
        !lowerHex(config.workspace.value, 64) ||
        (!config.enrollmentToken.empty() &&
         !lowerHex(config.enrollmentToken.value, 64)) ||
        (!config.sdkToken.empty() &&
         (!validSdkToken(config.sdkToken.value, config.workspace.value) ||
          !validRequestId(config.requestId.value) || config.requestCreatedAtMs == 0)) || config.rootCa.empty() ||
        std::strlen(config.rootCa.value) >= sizeof(config.rootCa.value) - 1 ||
        !std::strstr(config.rootCa.value, "-----BEGIN CERTIFICATE-----") ||
        !std::strstr(config.rootCa.value, "-----END CERTIFICATE-----")) return false;
    constexpr const char *prefix = "https://";
    if (std::strncmp(config.origin.value, prefix, std::strlen(prefix)) != 0) return false;
    const char *host = config.origin.value + std::strlen(prefix);
    return *host && !std::strpbrk(host, "/?#@ \t\r\n");
  }

  static bool validSdkToken(const char *token, const char *workspace) {
    const char *id = nullptr;
    if (std::strncmp(token, "ol_sdk_", 7) == 0) id = token + 7;
    else if (std::strncmp(token, "ol_agent_", 9) == 0) id = token + 9;
    else return false;
    if (std::strlen(id) != 129 || id[64] != '_' || std::strncmp(id, workspace, 64) != 0)
      return false;
    for (std::size_t i = 65; i < 129; ++i)
      if (!((id[i] >= '0' && id[i] <= '9') ||
            (id[i] >= 'a' && id[i] <= 'f'))) return false;
    return true;
  }

  static bool validRequestId(const char *id) {
    if (std::strlen(id) != 36) return false;
    for (std::size_t i = 0; i < 36; ++i) {
      if (i == 8 || i == 13 || i == 18 || i == 23) {
        if (id[i] != '-') return false;
      } else if (!((id[i] >= '0' && id[i] <= '9') ||
                   (id[i] >= 'a' && id[i] <= 'f'))) return false;
    }
    return true;
  }

  Preferences preferences_;
  Preferences configPreferences_;
  bool ready_ = false;
};

class Esp32HttpTransport final : public Transport {
 public:
  Esp32HttpTransport(const char *origin, const char *workspace,
                     const char *trustedRootCa, std::uint16_t timeoutMs = 12000)
      : origin_(origin ? origin : ""), trustedRootCa_(trustedRootCa),
        timeoutMs_(timeoutMs) {
    if (workspace) workspace_.set(workspace);
    while (origin_.endsWith("/")) origin_.remove(origin_.length() - 1);
    valid_ = validOrigin(origin_) && workspace_.value[0] != '\0' &&
             trustedRootCa_ && std::strstr(trustedRootCa_, "BEGIN CERTIFICATE") &&
             timeoutMs_ > 0;
  }

  bool ready() const { return valid_; }
  // `HttpError` is intentionally generic in the portable interface. Callers
  // can inspect this value to distinguish authorization/validation errors
  // from transient server responses before choosing whether to retry.
  int lastHttpStatusCode() const { return lastHttpStatusCode_; }

  TransportStatus enroll(const WorkspaceId &workspace, const EnrollmentToken &token,
                         const Manifest &manifest, Identity &out) override {
    if (!valid_ || !validWorkspace(workspace) || token.empty() ||
        std::strlen(token.value) != 64 || manifest.name.empty() || manifest.kind.empty() ||
        manifest.capabilityCount == 0 || manifest.capabilityCount > kCapabilityCount ||
        (manifest.hasFunctions && manifest.functionsJson.empty()))
      return TransportStatus::InvalidResponse;
    JsonDocument request;
    request["token"] = token.value;
    JsonObject payload = request["manifest"].to<JsonObject>();
    payload["name"] = manifest.name.value;
    payload["kind"] = manifest.kind.value;
    JsonArray capabilities = payload["capabilities"].to<JsonArray>();
    for (std::uint8_t i = 0; i < manifest.capabilityCount; ++i) {
      if (manifest.capabilities[i].empty()) return TransportStatus::InvalidResponse;
      capabilities.add(manifest.capabilities[i].value);
    }
    if (manifest.hasFunctions) {
      JsonDocument parsedFunctions;
      if (deserializeJson(parsedFunctions, manifest.functionsJson.value) ||
          !parsedFunctions.is<JsonArray>()) return TransportStatus::InvalidResponse;
      JsonArray functions = payload["functions"].to<JsonArray>();
      if (!functions.set(parsedFunctions.as<JsonArrayConst>()))
        return TransportStatus::InvalidResponse;
    }
    JsonDocument response;
    const auto status = post("/v1/device/enroll", workspace, nullptr, request, response);
    if (status != TransportStatus::Ok) return status;
    JsonVariantConst data = response["data"];
    if (!copyText(out.deviceId, data["deviceId"]) ||
        !copyText(out.credential, data["token"])) return TransportStatus::InvalidResponse;
    return TransportStatus::Ok;
  }

  TransportStatus attachSdkToken(const WorkspaceId &workspace, const SdkToken &token,
                                 const RequestId &requestId, const Manifest &manifest,
                                 Identity &out) override {
    if (!valid_ || !validWorkspace(workspace) || !sdkTokenMatchesWorkspace(token, workspace) ||
        !validRequestId(requestId) || manifest.name.empty() || manifest.kind.empty() ||
        manifest.capabilityCount == 0 || manifest.capabilityCount > kCapabilityCount ||
        (manifest.hasFunctions && manifest.functionsJson.empty()))
      return TransportStatus::InvalidResponse;
    JsonDocument request;
    request["requestId"] = requestId.value;
    JsonObject payload = request["manifest"].to<JsonObject>();
    payload["name"] = manifest.name.value;
    payload["kind"] = manifest.kind.value;
    JsonArray capabilities = payload["capabilities"].to<JsonArray>();
    for (std::uint8_t i = 0; i < manifest.capabilityCount; ++i) {
      if (manifest.capabilities[i].empty()) return TransportStatus::InvalidResponse;
      capabilities.add(manifest.capabilities[i].value);
    }
    if (manifest.hasFunctions) {
      JsonDocument parsedFunctions;
      if (deserializeJson(parsedFunctions, manifest.functionsJson.value) ||
          !parsedFunctions.is<JsonArray>()) return TransportStatus::InvalidResponse;
      JsonArray functions = payload["functions"].to<JsonArray>();
      if (!functions.set(parsedFunctions.as<JsonArrayConst>()))
        return TransportStatus::InvalidResponse;
    }
    JsonDocument response;
    const auto status = post("/v1/sdk/devices", workspace, nullptr, request, response,
                             token.value);
    if (status != TransportStatus::Ok) return status;
    JsonVariantConst data = response["data"];
    if (!copyText(out.deviceId, data["deviceId"]) ||
        !copyText(out.credential, data["token"])) return TransportStatus::InvalidResponse;
    return TransportStatus::Ok;
  }

  TransportStatus next(const WorkspaceId &workspace, const Identity &identity,
                       Action &out) override {
    JsonDocument request;
    request.to<JsonObject>();
    JsonDocument response;
    const String path = String("/v1/device/") + identity.deviceId.value + "/next";
    const auto status = post(path, workspace, &identity, request, response);
    if (status != TransportStatus::Ok) return status;
    JsonVariantConst data = response["data"];
    if (data.isNull()) return TransportStatus::NoContent;
    if (!copyText(out.id, data["id"]) || !copyText(out.capability, data["capability"]) ||
        !data["args"].is<JsonObjectConst>() || !data["expiresAt"].is<std::uint64_t>())
      return TransportStatus::InvalidResponse;
    JsonDocument args;
    if (!args.set(data["args"].as<JsonObjectConst>()) ||
        measureJson(args) >= sizeof(out.argumentsJson.value))
      return TransportStatus::InvalidResponse;
    if (serializeJson(args, out.argumentsJson.value, sizeof(out.argumentsJson.value)) == 0)
      return TransportStatus::InvalidResponse;
    out.expiresAtMs = data["expiresAt"].as<std::uint64_t>();
    if (out.expiresAtMs == 0) return TransportStatus::InvalidResponse;
    return TransportStatus::Ok;
  }

  TransportStatus submitResult(const WorkspaceId &workspace, const Identity &identity,
                               const ResultReport &result) override {
    JsonDocument parsedResult;
    if (deserializeJson(parsedResult, result.resultJson.value))
      return TransportStatus::InvalidResponse;
    JsonDocument request;
    request["actionId"] = result.actionId.value;
    request["status"] = result.status == ResultStatus::Succeeded ? "succeeded" : "failed";
    if (!request["result"].set(parsedResult.as<JsonVariantConst>()))
      return TransportStatus::InvalidResponse;
    JsonDocument response;
    const String path = String("/v1/device/") + identity.deviceId.value + "/result";
    return post(path, workspace, &identity, request, response);
  }

 private:
  static constexpr std::size_t kRequestMax = 16 * 1024;
  static constexpr std::size_t kResponseMax = 8 * 1024;

  class BoundedBufferStream final : public Stream {
   public:
    BoundedBufferStream(char *buffer, std::size_t capacity)
        : buffer_(buffer), capacity_(capacity) {}
    int available() override { return 0; }
    int read() override { return -1; }
    int peek() override { return -1; }
    void flush() override {}
    std::size_t write(std::uint8_t byte) override {
      if (length_ >= capacity_) { overflow_ = true; return 0; }
      buffer_[length_++] = static_cast<char>(byte);
      buffer_[length_] = '\0';
      return 1;
    }
    std::size_t length() const { return length_; }
    bool overflow() const { return overflow_; }
   private:
    char *buffer_;
    std::size_t capacity_;
    std::size_t length_ = 0;
    bool overflow_ = false;
  };

  static bool validOrigin(const String &origin) {
    if (!origin.startsWith("https://") || origin.length() <= 8 ||
        origin.indexOf('@') >= 0 || origin.indexOf('?') >= 0 ||
        origin.indexOf('#') >= 0 || origin.indexOf(' ') >= 0) return false;
    const int slash = origin.indexOf('/', 8);
    return slash < 0;
  }

  static bool validWorkspace(const WorkspaceId &workspace) {
    if (std::strlen(workspace.value) != 64) return false;
    for (std::size_t i = 0; i < 64; ++i)
      if (!((workspace.value[i] >= '0' && workspace.value[i] <= '9') ||
            (workspace.value[i] >= 'a' && workspace.value[i] <= 'f'))) return false;
    return true;
  }

  static bool sdkTokenMatchesWorkspace(const SdkToken &token, const WorkspaceId &workspace) {
    const char *id = nullptr;
    if (std::strncmp(token.value, "ol_sdk_", 7) == 0) id = token.value + 7;
    else if (std::strncmp(token.value, "ol_agent_", 9) == 0) id = token.value + 9;
    else return false;
    if (std::strlen(id) != 129 || id[64] != '_' ||
        std::strncmp(id, workspace.value, 64) != 0) return false;
    for (std::size_t i = 65; i < 129; ++i)
      if (!((id[i] >= '0' && id[i] <= '9') ||
            (id[i] >= 'a' && id[i] <= 'f'))) return false;
    return true;
  }

  static bool validRequestId(const RequestId &requestId) {
    if (std::strlen(requestId.value) != 36) return false;
    for (std::size_t i = 0; i < 36; ++i) {
      if (i == 8 || i == 13 || i == 18 || i == 23) {
        if (requestId.value[i] != '-') return false;
      } else if (!((requestId.value[i] >= '0' && requestId.value[i] <= '9') ||
                   (requestId.value[i] >= 'a' && requestId.value[i] <= 'f'))) return false;
    }
    return true;
  }

  template <std::size_t N>
  static bool copyText(Text<N> &out, JsonVariantConst value) {
    const char *text = value.as<const char *>();
    return text && out.set(text);
  }

  TransportStatus post(const String &path, const WorkspaceId &workspace,
                       const Identity *identity, JsonDocument &request,
                       JsonDocument &response, const char *bearerOverride = nullptr) {
    lastHttpStatusCode_ = 0;
    if (!valid_ || !validWorkspace(workspace) ||
        std::strcmp(workspace.value, workspace_.value) != 0)
      return TransportStatus::InvalidResponse;
    const std::size_t bodyLength = measureJson(request);
    if (bodyLength > kRequestMax) return TransportStatus::InvalidResponse;
    std::unique_ptr<char[]> body(new (std::nothrow) char[bodyLength + 1]);
    std::unique_ptr<char[]> reply(new (std::nothrow) char[kResponseMax + 1]);
    if (!body || !reply) return TransportStatus::NetworkError;
    if (serializeJson(request, body.get(), bodyLength + 1) != bodyLength)
      return TransportStatus::InvalidResponse;

    NetworkClientSecure tls;
    tls.setCACert(trustedRootCa_);
    HTTPClient http;
    const String url = origin_ + path;
    if (!http.begin(tls, url)) return TransportStatus::NetworkError;
    http.setReuse(false);
    http.setTimeout(timeoutMs_);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-openlaunch-workspace", workspace.value);
    if (bearerOverride && *bearerOverride)
      http.addHeader("Authorization", String("Bearer ") + bearerOverride);
    else if (identity && identity->credential.value[0])
      http.addHeader("Authorization", String("Bearer ") + identity->credential.value);
    const int code = http.POST(reinterpret_cast<std::uint8_t *>(body.get()), bodyLength);
    if (code < 0) { http.end(); return TransportStatus::NetworkError; }
    lastHttpStatusCode_ = code;
    if (code < 200 || code >= 300) { http.end(); return TransportStatus::HttpError; }
    const int declaredLength = http.getSize();
    if (declaredLength > static_cast<int>(kResponseMax)) {
      http.end();
      return TransportStatus::InvalidResponse;
    }
    BoundedBufferStream sink(reply.get(), kResponseMax);
    const int copied = http.writeToStream(&sink);
    http.end();
    if (copied < 0 || sink.overflow() || sink.length() == 0)
      return TransportStatus::InvalidResponse;
    const DeserializationError error = deserializeJson(response, reply.get(), sink.length());
    if (error || response["data"].isUnbound())
      return TransportStatus::InvalidResponse;
    return TransportStatus::Ok;
  }

  String origin_;
  WorkspaceId workspace_;
  const char *trustedRootCa_ = nullptr;
  std::uint16_t timeoutMs_;
  bool valid_ = false;
  int lastHttpStatusCode_ = 0;
};

}  // namespace openlaunch
