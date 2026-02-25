#include <Wire.h>
#include <Servo.h>

// ---- Hardware pins/addresses ----
const uint8_t MPU_ADDR = 0x68;
const int SERVO_PIN = 9;

// ---- Servo behavior ----
const int SERVO_MIN_ANGLE = 0;
const int SERVO_MAX_ANGLE = 180;
const int SERVO_DEFAULT_ANGLE = 90;
const int SERVO_SWEEP_MIN = 60;
const int SERVO_SWEEP_MAX = 120;
const int SERVO_STEP_DEG = 1;
const unsigned long SERVO_STEP_MS = 20;

// ---- Telemetry behavior ----
const unsigned long DEFAULT_TELEMETRY_INTERVAL_MS = 100;  // 10 Hz

enum MotionMode : uint8_t {
  MODE_STOP = 0,   // servo detached (quiet stop)
  MODE_HOLD = 1,   // smooth move to target and hold
  MODE_SWEEP = 2,  // autonomous sweep
};

Servo gServo;
bool gServoAttached = false;
MotionMode gMode = MODE_HOLD;
int gServoCurrent = SERVO_DEFAULT_ANGLE;
int gServoTarget = SERVO_DEFAULT_ANGLE;
int gSweepDir = 1;

bool gImuEnabled = true;
unsigned long gTelemetryIntervalMs = DEFAULT_TELEMETRY_INTERVAL_MS;
unsigned long gLastTelemetryMs = 0;
unsigned long gLastServoMs = 0;

int16_t gAx = 0, gAy = 0, gAz = 0, gGx = 0, gGy = 0, gGz = 0;

String gLine;

int clampInt(int value, int minValue, int maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

bool isDigitsOrSign(const String &s) {
  if (s.length() == 0) return false;
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s.charAt(i);
    if (!(c >= '0' && c <= '9') && !(i == 0 && c == '-')) return false;
  }
  return true;
}

void attachServoIfNeeded() {
  if (!gServoAttached) {
    gServo.attach(SERVO_PIN);
    gServoAttached = true;
    delay(5);
    gServo.write(gServoCurrent);
  }
}

void detachServoIfNeeded() {
  if (gServoAttached) {
    gServo.detach();
    gServoAttached = false;
  }
}

void setTargetAngle(int angle) {
  gServoTarget = clampInt(angle, SERVO_MIN_ANGLE, SERVO_MAX_ANGLE);
  attachServoIfNeeded();
  gMode = MODE_HOLD;
}

void stopServo() {
  gMode = MODE_STOP;
  detachServoIfNeeded();
}

const char *modeToText(MotionMode mode) {
  switch (mode) {
    case MODE_STOP:
      return "stop";
    case MODE_HOLD:
      return "hold";
    case MODE_SWEEP:
      return "sweep";
    default:
      return "unknown";
  }
}

void sendAck(const char *cmd, bool ok, const char *detail) {
  Serial.print("{\"event\":\"ack\",\"cmd\":\"");
  Serial.print(cmd);
  Serial.print("\",\"ok\":");
  Serial.print(ok ? "true" : "false");
  Serial.print(",\"detail\":\"");
  Serial.print(detail);
  Serial.println("\"}");
}

void sendStatus() {
  Serial.print("{\"event\":\"status\",\"mode\":\"");
  Serial.print(modeToText(gMode));
  Serial.print("\",\"servo\":");
  Serial.print(gServoCurrent);
  Serial.print(",\"target\":");
  Serial.print(gServoTarget);
  Serial.print(",\"imu_enabled\":");
  Serial.print(gImuEnabled ? "true" : "false");
  Serial.print(",\"telemetry_ms\":");
  Serial.print(gTelemetryIntervalMs);
  Serial.println("}");
}

void mpuWrite(uint8_t reg, uint8_t data) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(data);
  Wire.endTransmission();
}

bool mpuRead14(uint8_t startReg, uint8_t *buf) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(startReg);
  if (Wire.endTransmission(false) != 0) return false;

  uint8_t n = Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)14);
  if (n != 14) return false;

  for (uint8_t i = 0; i < 14; i++) buf[i] = Wire.read();
  return true;
}

bool parseNumberAfterKey(const String &line, const char *key, int &outValue) {
  int keyPos = line.indexOf(key);
  if (keyPos < 0) return false;

  int pos = keyPos + (int)strlen(key);
  while (pos < (int)line.length()) {
    char c = line.charAt(pos);
    if ((c >= '0' && c <= '9') || c == '-') break;
    pos++;
  }
  if (pos >= (int)line.length()) return false;

  int end = pos;
  while (end < (int)line.length()) {
    char c = line.charAt(end);
    if (!((c >= '0' && c <= '9') || c == '-')) break;
    end++;
  }
  String token = line.substring(pos, end);
  if (!isDigitsOrSign(token)) return false;
  outValue = token.toInt();
  return true;
}

void handleCommand(String line) {
  line.trim();
  if (line.length() == 0) return;
  line.replace("\r", "");
  line.replace("\n", "");

  String upper = line;
  upper.toUpperCase();

  // --- Explicit keywords ---
  if (upper == "STOP" || upper == "CENTER_STOP") {
    stopServo();
    sendAck("STOP", true, "servo_detached");
    return;
  }
  if (upper == "HOLD") {
    attachServoIfNeeded();
    gServoTarget = gServoCurrent;
    gMode = MODE_HOLD;
    sendAck("HOLD", true, "hold_current_angle");
    return;
  }
  if (upper == "RUN" || upper == "SWEEP_ON") {
    attachServoIfNeeded();
    gMode = MODE_SWEEP;
    sendAck("SWEEP_ON", true, "sweep_enabled");
    return;
  }
  if (upper == "SWEEP_OFF") {
    attachServoIfNeeded();
    gServoTarget = gServoCurrent;
    gMode = MODE_HOLD;
    sendAck("SWEEP_OFF", true, "sweep_disabled");
    return;
  }
  if (upper == "CENTER") {
    setTargetAngle(90);
    sendAck("CENTER", true, "target_90");
    return;
  }
  if (upper == "IMU_ON") {
    gImuEnabled = true;
    sendAck("IMU_ON", true, "imu_enabled");
    return;
  }
  if (upper == "IMU_OFF") {
    gImuEnabled = false;
    sendAck("IMU_OFF", true, "imu_disabled");
    return;
  }
  if (upper == "IMU?" || upper == "STATUS?") {
    sendStatus();
    return;
  }

  // RATE=10 or RATE:10
  if (upper.startsWith("RATE=") || upper.startsWith("RATE:")) {
    int hz = upper.substring(5).toInt();
    hz = clampInt(hz, 1, 50);
    gTelemetryIntervalMs = (unsigned long)(1000 / hz);
    sendAck("RATE", true, "telemetry_rate_updated");
    return;
  }

  // A90
  if (upper.startsWith("A") && upper.length() > 1) {
    int angle = upper.substring(1).toInt();
    setTargetAngle(angle);
    sendAck("A", true, "angle_target_set");
    return;
  }

  // P1500 (microseconds)
  if (upper.startsWith("P") && upper.length() > 1) {
    int pulse = upper.substring(1).toInt();
    pulse = clampInt(pulse, 500, 2500);
    int angle = map(pulse, 500, 2500, 0, 180);
    setTargetAngle(angle);
    sendAck("P", true, "pulse_target_set");
    return;
  }

  // 90
  if (isDigitsOrSign(upper)) {
    int angle = upper.toInt();
    setTargetAngle(angle);
    sendAck("ANGLE", true, "angle_target_set");
    return;
  }

  // Minimal JSON-like compatibility:
  // {"servo_pos":90}, {"servo_angle":90}, {"motor_pwm":1500}, {"target_velocity":0}
  int value = 0;
  if (parseNumberAfterKey(line, "servo_pos", value) ||
      parseNumberAfterKey(line, "servo_angle", value)) {
    setTargetAngle(value);
    sendAck("JSON_SERVO", true, "servo_target_set");
    return;
  }
  if (parseNumberAfterKey(line, "motor_pwm", value)) {
    int pulse = clampInt(value, 500, 2500);
    int angle = map(pulse, 500, 2500, 0, 180);
    setTargetAngle(angle);
    sendAck("JSON_PWM", true, "motor_pwm_mapped_to_angle");
    return;
  }
  if (parseNumberAfterKey(line, "target_velocity", value)) {
    if (value == 0) {
      stopServo();
      sendAck("JSON_VEL", true, "velocity_zero_stop");
    } else {
      attachServoIfNeeded();
      gMode = MODE_SWEEP;
      sendAck("JSON_VEL", true, "velocity_nonzero_sweep");
    }
    return;
  }

  sendAck("UNKNOWN", false, "unsupported_command");
}

void processSerialInput() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      handleCommand(gLine);
      gLine = "";
    } else if (c != '\r') {
      gLine += c;
      if (gLine.length() > 96) {
        gLine = "";
      }
    }
  }
}

void updateServoMotion() {
  unsigned long now = millis();
  if (now - gLastServoMs < SERVO_STEP_MS) return;
  gLastServoMs = now;

  if (gMode == MODE_STOP) return;
  attachServoIfNeeded();

  if (gMode == MODE_SWEEP) {
    gServoCurrent += gSweepDir * SERVO_STEP_DEG;
    if (gServoCurrent >= SERVO_SWEEP_MAX) {
      gServoCurrent = SERVO_SWEEP_MAX;
      gSweepDir = -1;
    } else if (gServoCurrent <= SERVO_SWEEP_MIN) {
      gServoCurrent = SERVO_SWEEP_MIN;
      gSweepDir = 1;
    }
    gServo.write(gServoCurrent);
    return;
  }

  // MODE_HOLD
  if (gServoCurrent < gServoTarget) {
    gServoCurrent += SERVO_STEP_DEG;
    if (gServoCurrent > gServoTarget) gServoCurrent = gServoTarget;
    gServo.write(gServoCurrent);
  } else if (gServoCurrent > gServoTarget) {
    gServoCurrent -= SERVO_STEP_DEG;
    if (gServoCurrent < gServoTarget) gServoCurrent = gServoTarget;
    gServo.write(gServoCurrent);
  }
}

void emitTelemetry() {
  if (!gImuEnabled) return;
  unsigned long now = millis();
  if (now - gLastTelemetryMs < gTelemetryIntervalMs) return;
  gLastTelemetryMs = now;

  bool mpuOk = false;
  uint8_t buf[14];
  if (mpuRead14(0x3B, buf)) {
    gAx = (int16_t)((buf[0] << 8) | buf[1]);
    gAy = (int16_t)((buf[2] << 8) | buf[3]);
    gAz = (int16_t)((buf[4] << 8) | buf[5]);
    gGx = (int16_t)((buf[8] << 8) | buf[9]);
    gGy = (int16_t)((buf[10] << 8) | buf[11]);
    gGz = (int16_t)((buf[12] << 8) | buf[13]);
    mpuOk = true;
  }

  Serial.print("{\"ts\":");
  Serial.print(now);
  Serial.print(",\"ax\":");
  Serial.print(gAx);
  Serial.print(",\"ay\":");
  Serial.print(gAy);
  Serial.print(",\"az\":");
  Serial.print(gAz);
  Serial.print(",\"gx\":");
  Serial.print(gGx);
  Serial.print(",\"gy\":");
  Serial.print(gGy);
  Serial.print(",\"gz\":");
  Serial.print(gGz);
  Serial.print(",\"servo\":");
  Serial.print(gServoCurrent);
  Serial.print(",\"mode\":\"");
  Serial.print(modeToText(gMode));
  Serial.print("\",\"mpu_ok\":");
  Serial.print(mpuOk ? "true" : "false");
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  delay(80);
  mpuWrite(0x6B, 0x00);  // Wake MPU6050
  delay(50);

  attachServoIfNeeded();
  gServo.write(gServoCurrent);
  gMode = MODE_HOLD;  // Safe default: no auto sweep on power-up.

  Serial.println("{\"event\":\"ready\",\"firmware\":\"uno_mpu6050_servo_runtime\",\"baud\":115200}");
  sendStatus();
}

void loop() {
  processSerialInput();
  updateServoMotion();
  emitTelemetry();
}
