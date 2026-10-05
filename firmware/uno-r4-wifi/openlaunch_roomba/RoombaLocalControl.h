#ifndef OPENLAUNCH_ROOMBA_LOCAL_CONTROL_H
#define OPENLAUNCH_ROOMBA_LOCAL_CONTROL_H

// Owner-selected wiring policy, never an agent argument. The normal OI harness
// uses Serial1, BRC and power only. Select true only for a build with separate
// Arduino-local D6 enable and D7 stop/permit switches installed.
static const bool ROOMBA_REQUIRE_LOCAL_CONTACTS = false;

class RoombaLocalControl {
 public:
  explicit RoombaLocalControl(bool requireContacts) : requireContacts_(requireContacts) {}
  bool allows(bool ready, bool enableClosed, bool stopClosed) {
    if (!requireContacts_) return ready;
    if (!stopClosed) { enableReleased_ = false; return false; }
    if (!enableClosed) { enableReleased_ = true; return false; }
    return ready && enableReleased_;
  }
 private:
  bool requireContacts_;
  bool enableReleased_ = false;
};

#endif
