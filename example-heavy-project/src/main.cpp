#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <TFT_eSPI.h>
#include <FastLED.h>
#include "generated/workload.h"

WebServer server(80);
TFT_eSPI display;
CRGB indicator = CRGB::Black;
volatile float checksum = 0.5f;

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_OFF);
  FastLED.setBrightness(16);
  server.on("/", HTTP_GET, []() {
    JsonDocument document;
    document["project"] = "compilez-heavy";
    document["checksum"] = checksum;
    document["display_width"] = display.width();
    String response;
    serializeJson(document, response);
    server.send(200, "application/json", response);
  });
  Serial.printf("CompileZ heavy workload: %u translation units\n", compilez_heavy::unit_count);
}

void loop() {
  checksum = compilez_heavy::run(checksum);
  indicator = CHSV(static_cast<uint8_t>(millis() / 100), 200, 32);
  JsonDocument document;
  document["checksum"] = checksum;
  document["uptime_ms"] = millis();
  serializeJson(document, Serial);
  Serial.println();
  delay(1000);
}