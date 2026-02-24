import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { AccessToken } from "livekit-server-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const apiKey        = process.env.LIVEKIT_API_KEY;
const apiSecret     = process.env.LIVEKIT_API_SECRET;
const publicWss     = process.env.PUBLIC_LIVEKIT_WSS  || "wss://livekit.lcaswitzerland.ch";
const localWss      = process.env.LOCAL_LIVEKIT_WSS   || "ws://192.168.1.136:7880";
const adminPassword = process.env.ADMIN_PASSWORD       || "changeme";
const accessToken   = process.env.ACCESS_TOKEN         || "changeme";

let rooms = ["FR", "EN", "DE"];

function randomId() {
  return "user-" + Math.random().toString(16).slice(2);
}

function isLocalRequest(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
           || req.socket.remoteAddress
           || "";
  return (
    ip === "::1"              ||
    ip === "127.0.0.1"        ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.")      ||
    ip.startsWith("172.")
  );
}

function checkAdmin(req, res) {
  if (req.headers["x-admin-password"] !== adminPassword) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function tokenFor(room, name, role) {
  const at = new AccessToken(apiKey, apiSecret, { identity: name, name });
  at.addGrant({
    room,
    roomJoin:     true,
    canSubscribe: true,
    canPublish:   role === "speak",
  });
  return await at.toJwt();
}

const PUBLIC_PATHS = ["/token", "/rooms", "/health"];

app.use((req, res, next) => {
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  if (req.query.token !== accessToken) {
    return res.status(403).send(`
      <html>
        <body style="font-family:system-ui;margin:40px;max-width:400px">
          <h2>Access Denied</h2>
          <p>Please add <code>?token=yourtoken</code> to the URL.</p>
        </body>
      </html>
    `);
  }
  next();
});

app.get("/rooms", (req, res) => res.json({ rooms }));

app.post("/rooms", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const name = String(req.body.name || "").trim().toUpperCase();
  if (!name)                return res.status(400).json({ error: "Room name required" });
  if (rooms.includes(name)) return res.status(409).json({ error: "Room already exists" });
  rooms.push(name);
  res.json({ rooms });
});

app.delete("/rooms/:name", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const name = req.params.name.toUpperCase();
  if (!rooms.includes(name)) return res.status(404).json({ error: "Room not found" });
  rooms = rooms.filter(r => r !== name);
  res.json({ rooms });
});

app.get("/token", async (req, res) => {
  try {
    const room = String(req.query.room || rooms[0] || "FR");
    const name = String(req.query.name || randomId());
    const role = String(req.query.role || "listen");
    if (!rooms.includes(room.toUpperCase()) && !rooms.includes(room)) {
      return res.status(400).json({ error: "Unknown room" });
    }
    const token      = await tokenFor(room, name, role);
    const livekitUrl = isLocalRequest(req) ? localWss : publicWss;
    console.log("Request from", req.socket.remoteAddress, "-> using", livekitUrl);
    res.json({ token, livekitUrl });
  } catch (e) {
    console.error("Token error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true, publicWss, localWss, rooms }));

app.use("/", express.static(path.join(__dirname, "public")));

app.listen(8080, () => {
  console.log("livekit-web on :8080");
  console.log("  public WSS:", publicWss);
  console.log("  local  WSS:", localWss);
});