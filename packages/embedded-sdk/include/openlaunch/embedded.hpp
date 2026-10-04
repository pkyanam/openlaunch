#pragma once

// Small protocol/session core for constrained devices. This header has no
// Arduino, JSON, TLS, or operating-system dependency. A platform adapter owns
// serialization and must implement verified HTTPS (never disable peer checks).
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace openlaunch {

constexpr std::size_t kDeviceIdSize = 37;
constexpr std::size_t kCredentialSize = 129;
constexpr std::size_t kWorkspaceSize = 65;
constexpr std::size_t kTokenSize = 129;
constexpr std::size_t kNameSize = 65;
constexpr std::size_t kKindSize = 65;
constexpr std::size_t kCapabilityCount = 16;
constexpr std::size_t kCapabilitySize = 65;
constexpr std::size_t kFunctionsJsonSize = 8193;
constexpr std::size_t kActionIdSize = 37;
constexpr std::size_t kArgumentsJsonSize = 2049;
constexpr std::size_t kResultJsonSize = 4097;

template <std::size_t N> struct Text {
  char value[N]{};
  bool set(const char *s) {
    if (!s) return false;
    const auto n = std::strlen(s);
    if (n >= N) return false;
    std::memcpy(value, s, n + 1);
    return true;
  }
  bool empty() const { return value[0] == '\0'; }
};

using DeviceId = Text<kDeviceIdSize>;
using Credential = Text<kCredentialSize>;
using WorkspaceId = Text<kWorkspaceSize>;
using EnrollmentToken = Text<kTokenSize>;
using ActionId = Text<kActionIdSize>;

struct Manifest {
  Text<kNameSize> name;
  Text<kKindSize> kind;
  Text<kCapabilitySize> capabilities[kCapabilityCount];
  std::uint8_t capabilityCount = 0;
  // Optional JSON array containing custom definitions in bridge manifest
  // format. hasFunctions distinguishes absent from the explicit [].
  Text<kFunctionsJsonSize> functionsJson;
  bool hasFunctions = false;
};

struct Identity {
  DeviceId deviceId;
  Credential credential;
};

// argumentsJson is the serialized JSON object for args. The transport adapter
// must validate JSON while decoding and enforce the server's 16 KiB body cap.
struct Action {
  ActionId id;
  Text<kCapabilitySize> capability;
  Text<kArgumentsJsonSize> argumentsJson;
  std::uint64_t expiresAtMs = 0;
};

enum class ResultStatus : std::uint8_t { Succeeded, Failed };
// resultJson must be a JSON value and no longer than 4096 bytes including NUL.
struct ResultReport {
  ActionId actionId;
  ResultStatus status = ResultStatus::Failed;
  std::uint64_t expiresAtMs = 0;
  Text<kResultJsonSize> resultJson;
};

enum class TransportStatus : std::uint8_t {
  Ok,
  NoContent,
  NetworkError,
  HttpError,
  InvalidResponse,
};

// Implementations perform these exact bridge operations:
// POST /v1/device/enroll {token, manifest}; serialize functionsJson as the
// manifest's functions array when hasFunctions, and validate it is a JSON array
// of bridge-compatible definitions before sending.
// POST /v1/device/{deviceId}/next {} with x-openlaunch-workspace and bearer
// POST /v1/device/{deviceId}/result {actionId,status,result} with same headers
// HTTP adapters must use HTTPS with certificate/hostname verification. The
// workspace header is required on every call. Enrollment is unauthenticated.
class Transport {
 public:
  virtual ~Transport() = default;
  virtual TransportStatus enroll(const WorkspaceId &, const EnrollmentToken &,
                                 const Manifest &, Identity &) = 0;
  virtual TransportStatus next(const WorkspaceId &, const Identity &,
                               Action &) = 0;
  virtual TransportStatus submitResult(const WorkspaceId &, const Identity &,
                                       const ResultReport &) = 0;
};

class Clock {
 public:
  virtual ~Clock() = default;
  // Return false when wall-clock time is unavailable or not trustworthy.
  virtual bool unixTimeMs(std::uint64_t &out) const = 0;
};

// Store implementations should use platform-appropriate protected storage.
// savePendingResult must be durable before submitResult is attempted; clear only
// after the server confirms success. No credential logging is permitted.
class Persistence {
 public:
  virtual ~Persistence() = default;
  enum class ReadStatus : std::uint8_t { Found, Empty, Error };
  virtual ReadStatus loadIdentity(Identity &) = 0;
  virtual bool saveIdentity(const Identity &) = 0;
  virtual ReadStatus loadPendingResult(ResultReport &) = 0;
  virtual bool savePendingResult(const ResultReport &) = 0;
  virtual bool clearPendingResult() = 0;
};

enum class Status : std::uint8_t {
  Ok,
  NoAction,
  InvalidArgument,
  NotPaired,
  StorageError,
  TransportError,
  ClockUnavailable,
  Expired,
  PendingResult,
  AlreadyPaired,
};

class DeviceClient {
 public:
  DeviceClient(Transport &transport, Clock &clock, Persistence &storage,
               const WorkspaceId &workspace)
      : transport_(transport), clock_(clock), storage_(storage), workspace_(workspace) {}

  Status enroll(const EnrollmentToken &token, const Manifest &manifest) {
    if (workspace_.empty() || token.empty() || !validManifest(manifest))
      return Status::InvalidArgument;
    Identity saved;
    const auto identityStatus = storage_.loadIdentity(saved);
    if (identityStatus == Persistence::ReadStatus::Error) return Status::StorageError;
    if (identityStatus == Persistence::ReadStatus::Found) return Status::AlreadyPaired;
    Identity fresh;
    const auto result = transport_.enroll(workspace_, token, manifest, fresh);
    if (result != TransportStatus::Ok) return Status::TransportError;
    if (fresh.deviceId.empty() || fresh.credential.empty())
      return Status::TransportError;
    if (!storage_.saveIdentity(fresh)) return Status::StorageError;
    identity_ = fresh;
    paired_ = true;
    return Status::Ok;
  }

  Status resume() {
    Identity saved;
    const auto read = storage_.loadIdentity(saved);
    if (read == Persistence::ReadStatus::Error) return Status::StorageError;
    if (read == Persistence::ReadStatus::Empty || saved.deviceId.empty() || saved.credential.empty()) {
      paired_ = false;
      return Status::NotPaired;
    }
    identity_ = saved;
    paired_ = true;
    return Status::Ok;
  }

  // A durable unacknowledged result blocks further polling. Call retryResult()
  // until confirmed, then poll again. This prevents lost reports and replay of
  // side-effecting work by a client that deliberately polls only once.
  Status nextAction(Action &out) {
    if (!paired_) return Status::NotPaired;
    ResultReport pending;
    const auto pendingStatus = storage_.loadPendingResult(pending);
    if (pendingStatus == Persistence::ReadStatus::Error) return Status::StorageError;
    if (pendingStatus == Persistence::ReadStatus::Found) return Status::PendingResult;
    Action candidate;
    const auto result = transport_.next(workspace_, identity_, candidate);
    if (result == TransportStatus::NoContent) return Status::NoAction;
    if (result != TransportStatus::Ok) return Status::TransportError;
    if (candidate.id.empty() || candidate.capability.empty() || candidate.argumentsJson.empty())
      return Status::InvalidArgument;
    std::uint64_t now = 0;
    if (!clock_.unixTimeMs(now)) return Status::ClockUnavailable;
    if (now >= candidate.expiresAtMs) return Status::Expired;
    out = candidate;
    return Status::Ok;
  }

  // Call after executing a still-valid action. Result is journaled before any
  // network attempt, and remains available to retryResult after a restart.
  Status reportResult(const Action &action, ResultStatus status, const char *resultJson) {
    if (!paired_) return Status::NotPaired;
    if (action.id.empty() || !resultJson) return Status::InvalidArgument;
    std::uint64_t now = 0;
    if (!clock_.unixTimeMs(now)) return Status::ClockUnavailable;
    if (now >= action.expiresAtMs) return Status::Expired;
    ResultReport report;
    report.actionId = action.id;
    report.status = status;
    report.expiresAtMs = action.expiresAtMs;
    if (!report.resultJson.set(resultJson)) return Status::InvalidArgument;
    ResultReport existing;
    const auto pendingStatus = storage_.loadPendingResult(existing);
    if (pendingStatus == Persistence::ReadStatus::Error) return Status::StorageError;
    if (pendingStatus == Persistence::ReadStatus::Found) return Status::PendingResult;
    if (!storage_.savePendingResult(report)) return Status::StorageError;
    return retryResult();
  }

  Status retryResult() {
    if (!paired_) return Status::NotPaired;
    ResultReport report;
    const auto pendingStatus = storage_.loadPendingResult(report);
    if (pendingStatus == Persistence::ReadStatus::Error) return Status::StorageError;
    if (pendingStatus == Persistence::ReadStatus::Empty) return Status::NoAction;
    if (report.actionId.empty() || report.resultJson.empty() || report.expiresAtMs == 0)
      return Status::StorageError;
    std::uint64_t now = 0;
    if (!clock_.unixTimeMs(now)) return Status::ClockUnavailable;
    if (now >= report.expiresAtMs) return Status::Expired;
    const auto result = transport_.submitResult(workspace_, identity_, report);
    if (result != TransportStatus::Ok) return Status::TransportError;
    if (!storage_.clearPendingResult()) return Status::StorageError;
    return Status::Ok;
  }

  // Explicitly abandon a pending report after operator review. This does not
  // replay the action; the bridge may already expose it as unknown at expiry.
  Status discardPendingResult() {
    if (!paired_) return Status::NotPaired;
    ResultReport report;
    const auto pendingStatus = storage_.loadPendingResult(report);
    if (pendingStatus == Persistence::ReadStatus::Error) return Status::StorageError;
    if (pendingStatus == Persistence::ReadStatus::Empty) return Status::NoAction;
    return storage_.clearPendingResult() ? Status::Ok : Status::StorageError;
  }

  const Identity *identity() const { return paired_ ? &identity_ : nullptr; }

 private:
  static bool validManifest(const Manifest &manifest) {
    if (manifest.name.empty() || manifest.kind.empty() || manifest.capabilityCount == 0 ||
        manifest.capabilityCount > kCapabilityCount) return false;
    if (manifest.hasFunctions && manifest.functionsJson.empty()) return false;
    for (std::uint8_t i = 0; i < manifest.capabilityCount; ++i) {
      const auto &capability = manifest.capabilities[i];
      if (capability.empty()) return false;
      const bool builtIn = std::strcmp(capability.value, "device.health") == 0 ||
                           std::strcmp(capability.value, "led.set") == 0 ||
                           std::strcmp(capability.value, "display.text") == 0;
      if (!builtIn && !manifest.hasFunctions) return false;
    }
    return true;
  }

  Transport &transport_;
  Clock &clock_;
  Persistence &storage_;
  WorkspaceId workspace_;
  Identity identity_{};
  bool paired_ = false;
};

}  // namespace openlaunch
