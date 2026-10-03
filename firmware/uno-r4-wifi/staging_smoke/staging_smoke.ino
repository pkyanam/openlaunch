// Compile-only staging check. Does not connect, enroll, or actuate external hardware.
#include <WiFiS3.h>
#include <Arduino_LED_Matrix.h>
ArduinoLEDMatrix matrix;
void setup() { Serial.begin(115200); matrix.begin(); Serial.println("openlaunch: staging smoke check"); }
void loop() { delay(1000); }
