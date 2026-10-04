#include <cassert>
#include <cstdio>
#include <cstring>
#include "openlaunch/embedded.hpp"

using namespace openlaunch;

struct FakeClock : Clock {
  bool valid = true;
  std::uint64_t now = 1000;
  bool unixTimeMs(std::uint64_t &out) const override {
    if (!valid) return false;
    out = now;
    return true;
  }
};

struct FakeStorage : Persistence {
  Identity identity{};
  ResultReport pending{};
  bool hasIdentity = false;
  bool hasPending = false;
  bool failSave = false;
  ReadStatus loadIdentity(Identity &out) override {
    if (!hasIdentity) return ReadStatus::Empty;
    out = identity;
    return ReadStatus::Found;
  }
  bool saveIdentity(const Identity &value) override {
    if (failSave) return false;
    identity = value;
    hasIdentity = true;
    return true;
  }
  ReadStatus loadPendingResult(ResultReport &out) override {
    if (!hasPending) return ReadStatus::Empty;
    out = pending;
    return ReadStatus::Found;
  }
  bool savePendingResult(const ResultReport &value) override {
    pending = value;
    hasPending = true;
    return true;
  }
  bool clearPendingResult() override {
    hasPending = false;
    return true;
  }
};

struct FakeTransport : Transport {
  TransportStatus enrollStatus = TransportStatus::Ok;
  TransportStatus nextStatus = TransportStatus::NoContent;
  TransportStatus resultStatus = TransportStatus::Ok;
  int enrollCalls = 0, nextCalls = 0, resultCalls = 0;
  Identity identity{};
  Action action{};
  ResultReport lastResult{};
  Manifest sentManifest{};

  TransportStatus enroll(const WorkspaceId &, const EnrollmentToken &,
                         const Manifest &manifest, Identity &out) override {
    ++enrollCalls;
    sentManifest = manifest;
    out = identity;
    return enrollStatus;
  }
  TransportStatus next(const WorkspaceId &, const Identity &,
                       Action &out) override {
    ++nextCalls;
    if (nextStatus == TransportStatus::Ok) out = action;
    return nextStatus;
  }
  TransportStatus submitResult(const WorkspaceId &, const Identity &,
                               const ResultReport &report) override {
    ++resultCalls;
    lastResult = report;
    return resultStatus;
  }
};

static DeviceClient makeClient(FakeTransport &transport, FakeClock &clock,
                               FakeStorage &storage, WorkspaceId &workspace) {
  return DeviceClient(transport, clock, storage, workspace);
}

int main() {
  WorkspaceId workspace;
  assert(workspace.set("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  EnrollmentToken token;
  assert(token.set("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
  Manifest manifest;
  assert(manifest.name.set("test board"));
  assert(manifest.kind.set("custom.test"));
  assert(manifest.capabilities[0].set("device.health"));
  assert(manifest.capabilities[1].set("custom.sensor.read"));
  manifest.capabilityCount = 2;
  manifest.hasFunctions = true;
  assert(manifest.functionsJson.set(
      "[{\"name\":\"custom.sensor.read\",\"title\":\"Read sensor\","
      "\"description\":\"Read a sensor value.\",\"access\":\"read\","
      "\"inputSchema\":{\"type\":\"object\",\"properties\":{},"
      "\"required\":[],\"additionalProperties\":false}}]"));

  FakeTransport transport;
  FakeClock clock;
  FakeStorage storage;
  assert(transport.identity.deviceId.set("00000000-0000-4000-8000-000000000001"));
  assert(transport.identity.credential.set("device-secret"));
  auto client = makeClient(transport, clock, storage, workspace);

  Action action;
  assert(client.nextAction(action) == Status::NotPaired);
  assert(client.enroll(token, manifest) == Status::Ok);
  assert(storage.hasIdentity && transport.enrollCalls == 1);
  assert(transport.sentManifest.hasFunctions);
  assert(std::strcmp(transport.sentManifest.functionsJson.value,
                     manifest.functionsJson.value) == 0);
  assert(client.enroll(token, manifest) == Status::AlreadyPaired);
  assert(transport.enrollCalls == 1);
  assert(client.identity() && std::strcmp(client.identity()->deviceId.value,
                                           transport.identity.deviceId.value) == 0);
  assert(client.nextAction(action) == Status::NoAction);
  assert(transport.nextCalls == 1);

  assert(transport.action.id.set("00000000-0000-4000-8000-000000000002"));
  assert(transport.action.capability.set("device.health"));
  assert(transport.action.argumentsJson.set("{}"));
  transport.action.expiresAtMs = 2000;
  transport.nextStatus = TransportStatus::Ok;
  assert(client.nextAction(action) == Status::Ok);
  assert(std::strcmp(action.id.value, transport.action.id.value) == 0);

  clock.valid = false;
  assert(client.nextAction(action) == Status::ClockUnavailable);
  clock.valid = true;
  clock.now = 2000;
  assert(client.nextAction(action) == Status::Expired);
  clock.now = 1000;

  transport.resultStatus = TransportStatus::NetworkError;
  assert(client.reportResult(action, ResultStatus::Succeeded, "{\"ok\":true}") ==
         Status::TransportError);
  assert(storage.hasPending && transport.resultCalls == 1);
  assert(storage.pending.expiresAtMs == action.expiresAtMs);
  assert(client.reportResult(action, ResultStatus::Succeeded, "{\"other\":true}") ==
         Status::PendingResult);
  assert(transport.resultCalls == 1);
  const int pollCount = transport.nextCalls;
  assert(client.nextAction(action) == Status::PendingResult);
  assert(transport.nextCalls == pollCount);
  transport.resultStatus = TransportStatus::Ok;
  assert(client.retryResult() == Status::Ok);
  assert(!storage.hasPending && transport.resultCalls == 2);
  assert(std::strcmp(transport.lastResult.resultJson.value, "{\"ok\":true}") == 0);

  // An expired result stays journaled until an explicit operator discard.
  transport.resultStatus = TransportStatus::NetworkError;
  assert(client.reportResult(action, ResultStatus::Failed, "{\"error\":\"retry\"}") ==
         Status::TransportError);
  const int beforeExpiredRetry = transport.resultCalls;
  clock.now = action.expiresAtMs;
  assert(client.retryResult() == Status::Expired);
  assert(transport.resultCalls == beforeExpiredRetry && storage.hasPending);
  assert(client.discardPendingResult() == Status::Ok);
  assert(!storage.hasPending);
  clock.now = 1000;

  // Device restart: identity and an unacknowledged result survive in storage.
  FakeStorage rebootStorage;
  rebootStorage.identity = storage.identity;
  rebootStorage.hasIdentity = true;
  rebootStorage.pending = transport.lastResult;
  rebootStorage.hasPending = true;
  FakeTransport afterReboot;
  FakeClock rebootClock;
  auto rebooted = makeClient(afterReboot, rebootClock, rebootStorage, workspace);
  assert(rebooted.resume() == Status::Ok);
  assert(rebooted.retryResult() == Status::Ok);
  assert(afterReboot.resultCalls == 1 && !rebootStorage.hasPending);

  // Storage failure must not result in an unjournaled network submission.
  FakeStorage failedStorage;
  failedStorage.failSave = true;
  FakeTransport finalTransport = transport;
  auto failedClient = makeClient(finalTransport, clock, failedStorage, workspace);
  assert(failedClient.enroll(token, manifest) == Status::StorageError);
  assert(finalTransport.resultCalls == transport.resultCalls);

  std::puts("embedded-sdk core checks passed");
}
