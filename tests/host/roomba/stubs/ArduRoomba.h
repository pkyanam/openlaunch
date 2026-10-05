#ifndef TEST_ARDUROOMBA_H
#define TEST_ARDUROOMBA_H

#include <stdint.h>

static unsigned long testMillis = 1234UL;
inline unsigned long millis() { return testMillis; }
inline void delay(unsigned long ms) { testMillis += ms; }

class RoombaSerial {
 public:
  bool active = true;
  int pending = 0;
  bool continuous = false;
  uint8_t lastWrite = 0;
  int writes = 0;
  bool isActive() const { return active; }
  int available() { return continuous ? 1 : pending; }
  int read() { if (!continuous && pending > 0) --pending; return 0; }
  void write(uint8_t value) { lastWrite = value; ++writes; }
  void flush() {}
};

class RoombaSensors {
 public:
  bool reply = true;
  uint8_t oiMode = 2;
  uint8_t requestedId = 0, requestedLength = 0;
  int queries = 0;
  bool getSensor(uint8_t id, uint8_t* bytes, uint8_t length) {
    requestedId = id; requestedLength = length;
    ++queries;
    if (!reply) return false;
    for (uint8_t i = 0; i < length; ++i) bytes[i] = id == 35 ? oiMode : static_cast<uint8_t>(i + 1);
    return true;
  }
};

class RoombaActuators {
 public:
  bool mainBrush = false, sideBrush = false, vacuum = false;
  uint8_t ledBits = 0, color = 0, intensity = 0;
  int stopCount = 0, toneCount = 0, songCount = 0, defineCount = 0;
  bool slotZeroIsTone = false, playedToneAsSong = false;
  int cleanCount = 0, spotCount = 0, maxCount = 0, dockCount = 0, safeModeCount = 0;
  void definePredefinedSongs() { ++defineCount; slotZeroIsTone = false; }
  void setAllLEDs(uint8_t b, uint8_t c, uint8_t i) { ledBits = b; color = c; intensity = i; }
  void playTone(uint8_t, uint8_t) { ++toneCount; slotZeroIsTone = true; }
  void playStartupSong() { ++songCount; playedToneAsSong = slotZeroIsTone; }
  void playHappySong() { ++songCount; }
  void playSadSong() { ++songCount; }
  void playAlertSong() { ++songCount; }
  void setMotors(bool m, bool s, bool v) { mainBrush = m; sideBrush = s; vacuum = v; }
  void stopAllMotors() { mainBrush = sideBrush = vacuum = false; ++stopCount; }
  void startCleaning() { ++cleanCount; }
  void startSpotClean() { ++spotCount; }
  void startMaxClean() { ++maxCount; }
  void seekDock() { ++dockCount; }
  void setSafeMode() { ++safeModeCount; }
};

class RoombaMovement {
 public:
  int directCount = 0;
  int16_t right = 0, left = 0;
  void driveDirect(int16_t r, int16_t l) { ++directCount; right = r; left = l; }
};

class ArduRoomba {
 public:
  bool connected = true, resumeResult = true;
  int stopCount = 0, resumeCount = 0;
  RoombaSerial serialPort;
  RoombaSensors sensorInterface;
  RoombaActuators actuatorInterface;
  RoombaMovement movementInterface;
  bool isConnected() const { return connected; }
  RoombaSerial* serial() { return &serialPort; }
  RoombaSensors& sensors() { return sensorInterface; }
  RoombaActuators& actuators() { return actuatorInterface; }
  RoombaMovement& movement() { return movementInterface; }
  void stop() { ++stopCount; }
  bool resumeControl() { ++resumeCount; return resumeResult; }
};

#endif
