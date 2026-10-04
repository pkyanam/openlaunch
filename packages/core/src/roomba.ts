/** Bounded Roomba movement functions for the Uno R4 firmware manifest. */
export const roombaFunctions = [
  {
    name: "roomba.stop",
    title: "Stop Roomba",
    description:
      "Send zero drive and brush-off. If firmware tracks an autonomous run, enter Safe mode first to abort it. This is a queued network action, not the physical emergency stop.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.sensor.read",
    title: "Read Roomba sensor packet",
    description:
      "Read one allowlisted 500-series OI sensor packet while idle. The result includes validity, capture time, and raw bytes only when complete; invalid is unknown, not clear.",
    access: "read",
    inputSchema: {
      type: "object",
      properties: {
        packetId: {
          type: "integer",
          minimum: 7,
          maximum: 42,
          description:
            "500-series packet ID. Firmware accepts 7–15, 17–31, and 34–42; 16 and 32–33 are unused and rejected.",
        },
      },
      required: ["packetId"],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.leds.set",
    title: "Set Roomba LEDs",
    description:
      "Set the model 551 dirt-detect, spot, dock, and check-robot LEDs plus power LED color and intensity.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {
        ledBits: {
          type: "integer",
          minimum: 0,
          maximum: 15,
          description:
            "Roomba 500/551 LED mask: bit 0 debris, bit 1 spot, bit 2 dock, bit 3 check robot.",
        },
        powerColor: {
          type: "integer",
          minimum: 0,
          maximum: 255,
          description: "Power LED color from green (0) through red (255).",
        },
        powerIntensity: {
          type: "integer",
          minimum: 0,
          maximum: 255,
          description: "Power LED intensity.",
        },
      },
      required: ["ledBits", "powerColor", "powerIntensity"],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.tone.play",
    title: "Play a Roomba tone",
    description:
      "Play one bounded note. Duration uses the OI song tick unit of 1/64 second.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {
        note: {
          type: "integer",
          minimum: 57,
          maximum: 92,
          description: "Supported note number from the library's note table.",
        },
        duration: {
          type: "integer",
          minimum: 1,
          maximum: 32,
          description:
            "Note duration in 1/64-second ticks, capped at 0.5 seconds.",
        },
      },
      required: ["note", "duration"],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.song.play",
    title: "Play a built-in Roomba song",
    description:
      "Play one of the four fixed songs loaded by firmware during startup.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {
        songId: {
          type: "integer",
          minimum: 0,
          maximum: 3,
          description:
            "Fixed song slot: startup, happy, sad, or alert; custom slots are unavailable.",
        },
      },
      required: ["songId"],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.brushes.burst",
    title: "Run Roomba brushes briefly",
    description:
      "Set brush and vacuum outputs for a short burst; firmware turns every output off when the local duration lease ends.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {
        mainBrush: { type: "boolean" },
        sideBrush: { type: "boolean" },
        vacuum: { type: "boolean" },
        durationMs: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Output lease duration in milliseconds.",
        },
      },
      required: ["mainBrush", "sideBrush", "vacuum", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.resume_safe",
    title: "Resume Roomba safe mode",
    description:
      "Re-enter Safe mode after a local physical enable is held. This does not enable Full mode or start autonomous cleaning.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.clean",
    title: "Start Roomba cleaning",
    description:
      "Start the robot's built-in autonomous cleaning mode. Requires the local enable and e-stop interlock; completion confirms command transmission only.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          maxLength: 8,
          enum: ["standard", "spot", "max"],
          description: "Built-in Roomba cleaning mode.",
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.dock",
    title: "Send Roomba to the dock",
    description:
      "Start the robot's built-in dock-seeking behavior. Requires the local enable and e-stop interlock; docking completion is not reported.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.pause",
    title: "Pause Roomba behavior",
    description:
      "Enter Safe mode, stop wheel drive, and turn brush outputs off. This ends the current autonomous run; issue a new clean or dock command to start again. It is a network action, not the physical emergency stop.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.drive",
    title: "Drive Roomba briefly",
    description:
      "Drive at a bounded velocity and radius for at most one second. A local enable and physical safety interlock are required.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {
        velocityMmS: {
          type: "integer",
          minimum: -150,
          maximum: 150,
          description: "Signed forward velocity in millimeters per second.",
        },
        radiusMm: {
          type: "integer",
          minimum: -2000,
          maximum: 2000,
          description:
            "Turn radius in millimeters: zero means straight, +1 or -1 means in-place rotation, and larger magnitudes make arcs.",
        },
        durationMs: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Movement burst duration in milliseconds.",
        },
      },
      required: ["velocityMmS", "radiusMm", "durationMs"],
      additionalProperties: false,
    },
  },
  {
    name: "roomba.drive_direct",
    title: "Drive Roomba wheels briefly",
    description:
      "Set independently bounded left and right wheel speeds for at most one second; firmware stops both wheels when the local lease ends.",
    access: "write",
    inputSchema: {
      type: "object",
      properties: {
        rightMmS: {
          type: "integer",
          minimum: -150,
          maximum: 150,
          description: "Signed right wheel velocity in millimeters per second.",
        },
        leftMmS: {
          type: "integer",
          minimum: -150,
          maximum: 150,
          description: "Signed left wheel velocity in millimeters per second.",
        },
        durationMs: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Movement burst duration in milliseconds.",
        },
      },
      required: ["rightMmS", "leftMmS", "durationMs"],
      additionalProperties: false,
    },
  },
];

export const roombaCapabilities = roombaFunctions.map(({ name }) => name);
