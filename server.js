const express = require("express");
const compression = require("compression");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const fs = require("fs");
const TOTAL_PRESSES = 5;
let presses = 0;
let launched = false;
const pressedSockets = new Set();
const pressedTablets = new Set();

const audioDir = path.join(__dirname, "public", "audio");
function detectDefaultVoiceover() {
  for (const name of ["voiceover.mp3", "voiceover.wav", "voiceover.m4a"]) {
    const full = path.join(audioDir, name);
    if (fs.existsSync(full)) {
      return {
        url: `/audio/${name}?v=${Math.floor(fs.statSync(full).mtimeMs)}`,
        name: "Voiceover Ready",
      };
    }
  }
  return { url: null, name: "Voiceover" };
}
const initVo = detectDefaultVoiceover();
const mapState = {
  soundEnabled: true,
  cleanMode: false,
  playing: false,
  hasPlayed: false,
  voiceoverUrl: initVo.url,
  voiceoverName: initVo.name,
};

function statePayload() {
  return {
    presses,
    total: TOTAL_PRESSES,
    percent: Math.min(100, Math.round((presses / TOTAL_PRESSES) * 100)),
    launched,
    pressedTablets: [...pressedTablets].sort(),
  };
}

app.use(compression());
app.use(
  "/videos",
  express.static(path.join(__dirname, "public/videos"), {
    maxAge: "1d",
    immutable: false,
  })
);
app.use(
  "/assets",
  express.static(path.join(__dirname, "public/assets"), {
    maxAge: "1d",
    immutable: false,
  })
);
app.use(
  "/audio",
  express.static(path.join(__dirname, "public/audio"), {
    maxAge: "1d",
    immutable: false,
  })
);
app.get("/nfb-map.html", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "nfb-map.html"));
});

app.use("/dict/initialize/launch/button.html", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public/dict/initialize/launch/button.html")
  );
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "video.html"));
});

function resetSequence() {
  presses = 0;
  launched = false;
  pressedSockets.clear();
  pressedTablets.clear();
}

app.post(
  "/api/voiceover",
  express.raw({ type: () => true, limit: "50mb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: "Empty audio body" });
    }
    const rawName = path.basename(String(req.get("x-filename") || "voiceover.wav"));
    const parsedExt = path.extname(rawName).toLowerCase();
    const allowedExt = [".wav", ".mp3", ".m4a", ".ogg", ".aac"];
    const ext = allowedExt.includes(parsedExt) ? parsedExt : ".wav";
    const safeName = rawName.replace(/[^a-zA-Z0-9._ -]/g, "_") || ("voiceover" + ext);
    fs.mkdirSync(audioDir, { recursive: true });
    const outFile = path.join(audioDir, "voiceover-custom" + ext);
    fs.writeFileSync(outFile, req.body);
    mapState.voiceoverUrl = `/audio/voiceover-custom${ext}?v=${Date.now()}`;
    mapState.voiceoverName = safeName;
    io.emit("map-state", mapState);
    io.emit("map-command", {
      type: "set-voiceover",
      url: mapState.voiceoverUrl,
      name: mapState.voiceoverName,
    });
    console.log(`Updated custom voiceover: ${safeName} (${req.body.length} bytes)`);
    res.json({ ok: true, mapState });
  }
);

app.get("/reset", (req, res) => {
  resetSequence();
  mapState.playing = false;
  mapState.cleanMode = false;
  io.emit("reset");
  io.emit("progress", statePayload());
  io.emit("map-state", mapState);
  console.log("Launch sequence reset");
  res.json({ ok: true, ...statePayload() });
});

// Fire the AVP immediately, regardless of presses.
app.get("/launch-now", (req, res) => {
  launched = true;
  presses = TOTAL_PRESSES;
  io.emit("progress", statePayload());
  io.emit("launch");
  console.log("Dashboard force-fired the launch AVP");
  res.json({ ok: true, launched });
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/video", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "video.html"));
});

io.on("connection", (socket) => {
  console.log("A user connected");

  // Sync current state so a late/reconnected display catches up.
  socket.emit("progress", statePayload());
  socket.emit("map-state", mapState);

  socket.on("map-control", (cmd) => {
    if (!cmd || typeof cmd !== "object") return;
    if (cmd.action === "toggle-sound" || cmd.action === "set-sound") {
      mapState.soundEnabled =
        cmd.action === "set-sound" ? Boolean(cmd.enabled) : !mapState.soundEnabled;
      io.emit("map-state", mapState);
      io.emit("map-command", { type: "set-sound", enabled: mapState.soundEnabled });
      console.log(`Map sound: ${mapState.soundEnabled ? "ON" : "OFF"}`);
    } else if (cmd.action === "toggle-clean" || cmd.action === "set-clean") {
      mapState.cleanMode =
        cmd.action === "set-clean" ? Boolean(cmd.enabled) : !mapState.cleanMode;
      io.emit("map-state", mapState);
      io.emit("map-command", { type: "set-clean", enabled: mapState.cleanMode });
      console.log(`Map UI hidden: ${mapState.cleanMode}`);
    } else if (cmd.action === "play-cinematic") {
      mapState.playing = true;
      mapState.hasPlayed = true;
      io.emit("map-state", mapState);
      io.emit("map-command", { type: "play-cinematic" });
      console.log("Dashboard triggered cinematic map play/replay");
    }
  });

  socket.on("map-status", (st) => {
    if (!st || typeof st !== "object") return;
    if (typeof st.playing === "boolean") {
      mapState.playing = st.playing;
      if (st.playing) mapState.hasPlayed = true;
    }
    if (typeof st.soundEnabled === "boolean") mapState.soundEnabled = st.soundEnabled;
    if (typeof st.cleanMode === "boolean") mapState.cleanMode = st.cleanMode;
    io.emit("map-state", mapState);
  });

  socket.on("pressLaunch", (data) => {
    if (launched) return;
    if (pressedSockets.has(socket.id)) return; // one press per tablet
    pressedSockets.add(socket.id);
    const tablet = data && Number(data.tablet) >= 1 && Number(data.tablet) <= TOTAL_PRESSES
      ? Number(data.tablet)
      : null;
    // A tablet number already used doesn't count twice.
    if (tablet !== null && pressedTablets.has(tablet)) return;
    if (tablet !== null) pressedTablets.add(tablet);
    presses += 1;
    console.log(`Launch pressed (${presses}/${TOTAL_PRESSES}) tablets=[${[...pressedTablets].join(",")}]`);
    io.emit("progress", statePayload());
    if (presses >= TOTAL_PRESSES) {
      launched = true;
      console.log("Launch complete -> firing AVP");
      io.emit("launch");
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

const PORT = process.env.PORT || 3333;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
