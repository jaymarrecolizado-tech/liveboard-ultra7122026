const express = require("express");
const compression = require("compression");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");
const TOTAL_PRESSES = 5;
let presses = 0;
let launched = false;
const pressedSockets = new Set();
const pressedTablets = new Set();

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

app.get("/reset", (req, res) => {
  resetSequence();
  io.emit("reset");
  io.emit("progress", statePayload());
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
