import express from "express";
import cors from "cors";
import path from "path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { AccessToken, EgressClient, RoomServiceClient, SegmentedFileOutput } from "livekit-server-sdk";
import { Store } from "./store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const apiKey      = process.env.LIVEKIT_API_KEY;
const apiSecret   = process.env.LIVEKIT_API_SECRET;
const publicWss   = process.env.PUBLIC_LIVEKIT_WSS || "ws://127.0.0.1:7880";
const localWss    = process.env.LOCAL_LIVEKIT_WSS || "ws://127.0.0.1:7880";
const internalUrl = process.env.INTERNAL_LIVEKIT_URL || "http://localhost:7880";
const linkBaseUrl = process.env.LINK_BASE_URL || "";
const dataPath    = process.env.DATA_PATH || path.join(__dirname, "data", "app-data.json");
const uploadRoot  = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");
const hlsRoot     = path.join(__dirname, "public", "hls");

const store = new Store(dataPath, {
  adminEmail: process.env.INITIAL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "admin@example.com",
  adminPassword: process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin",
});

const egressClient = new EgressClient(internalUrl, apiKey, apiSecret);
const roomClient = new RoomServiceClient(internalUrl, apiKey, apiSecret);
const sessions = new Map();

mkdirSync(hlsRoot, { recursive: true });
mkdirSync(uploadRoot, { recursive: true });

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function currentUser(req) {
  const sessionId = parseCookies(req).lv_session;
  const session = sessionId && sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    if (sessionId) sessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  return store.userById(session.userId);
}

function respondUnauthorized(req, res) {
  if (req.method === "GET" && req.path.startsWith("/admin")) {
    return res.redirect("/login");
  }
  if (req.accepts("html")) {
    return res.redirect("/login");
  }
  return res.status(401).json({ error: "Login required" });
}

function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) return respondUnauthorized(req, res);
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return respondUnauthorized(req, res);
  if (user.role !== "admin") return res.status(403).json({ error: "Admin required" });
  req.user = user;
  next();
}

function requireEventAccess(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Login required" });
  const eventId = req.params.eventId || store.channelById(req.params.channelId)?.eventId;
  if (!eventId || !store.canManageEvent(user, eventId)) {
    return res.status(403).json({ error: "Event access required" });
  }
  req.user = user;
  next();
}

function setSession(res, user) {
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    userId: user.id,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  });
  res.setHeader(
    "Set-Cookie",
    `lv_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
  );
}

function clearSession(req, res) {
  const sessionId = parseCookies(req).lv_session;
  if (sessionId) sessions.delete(sessionId);
  res.setHeader("Set-Cookie", "lv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function baseUrlFor(req) {
  if (linkBaseUrl) return linkBaseUrl.replace(/\/+$/, "");
  const forwardedHost = req.headers["x-forwarded-host"];
  const rawHost = String(forwardedHost || req.headers.host || "");
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  return `${proto}://${rawHost}`;
}

function pageUrl(req, event, channel, page, token) {
  const url = new URL(`/e/${event.slug}/${encodeURIComponent(channel.name)}/${page}`, baseUrlFor(req));
  url.searchParams.set("token", token);
  return url.toString();
}

function qrSvg(text) {
  return QRCode.toString(text, {
    type: "svg",
    margin: 1,
    width: 220,
    color: { dark: "#172026", light: "#ffffff" },
  });
}

function isLocalBrowserHost(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  const hostname = host.split(":")[0].replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function livekitUrlFor(req) {
  return isLocalBrowserHost(req) ? localWss : publicWss;
}

async function ensureLiveKitRoom(roomName) {
  try {
    await roomClient.createRoom({ name: roomName });
  } catch (e) {
    const message = String(e?.message || e || "");
    if (!message.toLowerCase().includes("already exists")) throw e;
  }
}

async function livekitToken(room, identity, role) {
  const at = new AccessToken(apiKey, apiSecret, { identity, name: identity });
  at.addGrant({
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublish: role === "speaker",
  });
  return await at.toJwt();
}

function channelContext(channel) {
  const event = store.eventById(channel.eventId);
  const logo = store.eventLogo(event.id);
  return {
    event,
    channel: {
      id: channel.id,
      name: channel.name,
      speakerTokenHint: channel.speakerTokenHint,
      listenerTokenHint: channel.listenerTokenHint,
    },
    logoUrl: logo ? `/event-assets/${event.slug}/logo.png` : "/logo.svg",
  };
}

async function startHls(channel) {
  const current = store.getHls(channel.id);
  if (current) return current;

  const roomName = store.roomNameFor(channel);
  await ensureLiveKitRoom(roomName);

  const streamId = randomUUID().replaceAll("-", "").slice(0, 20);
  const publicPrefix = `${channel.id}/${streamId}`;
  const output = new SegmentedFileOutput({
    filenamePrefix: `/out/${publicPrefix}/segment`,
    playlistName: `/out/${publicPrefix}/playlist.m3u8`,
    livePlaylistName: `/out/${publicPrefix}/live.m3u8`,
    segmentDuration: 2,
  });
  const info = await egressClient.startRoomCompositeEgress(roomName, { segments: output }, {
    audioOnly: true,
    layout: "speaker",
  });

  return store.setHls(channel.id, {
    egressId: info.egressId,
    streamId,
    playlistPath: `/hls/${publicPrefix}/live.m3u8`,
    status: "active",
    errorMessage: "",
  });
}

async function stopHls(channel) {
  const stream = store.getHls(channel.id);
  if (!stream) return null;
  try {
    await egressClient.stopEgress(stream.egressId);
  } catch (e) {
    console.error("HLS stop error:", e);
  }
  store.stopHls(channel.id);
  return stream;
}

function linksFor(req, channel) {
  const event = store.eventById(channel.eventId);
  return {
    speaker: pageUrl(req, event, channel, "speaker", channel.speakerToken),
    listener: pageUrl(req, event, channel, "listen", channel.listenerToken),
  };
}

function requirePublicChannel(req, res, role) {
  const event = store.eventBySlug(req.params.eventSlug);
  const channel = event && store.channelByEventAndName(event.id, req.params.channelName);
  if (!event || !channel || !store.verifyChannelToken(channel, role, req.query.token)) {
    res.status(403).send("Invalid or expired link.");
    return null;
  }
  return { event, channel };
}

function sendAppPage(req, res, file) {
  res.sendFile(path.join(__dirname, "public", file));
}

app.use("/hls", express.static(hlsRoot, {
  index: false,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));
app.get("/app.css", (_, res) => res.type("text/css").sendFile(path.join(__dirname, "public", "app.css")));
app.get("/app.js", (_, res) => res.type("application/javascript").sendFile(path.join(__dirname, "public", "app.js")));
app.get("/logo.svg", (_, res) => res.type("image/svg+xml").sendFile(path.join(__dirname, "public", "logo.svg")));
app.get("/favicon.ico", (_, res) => res.status(204).end());

app.get("/", (req, res) => {
  sendAppPage(req, res, currentUser(req) ? "admin.html" : "admin-login.html");
});

app.get("/index.html", (req, res) => {
  sendAppPage(req, res, currentUser(req) ? "admin.html" : "admin-login.html");
});

app.get("/login", (req, res) => sendAppPage(req, res, "admin-login.html"));
app.get("/admin", requireLogin, (req, res) => sendAppPage(req, res, "admin.html"));
app.get("/admin.html", requireLogin, (req, res) => sendAppPage(req, res, "admin.html"));

app.get("/e/:eventSlug/:channelName/speaker", (req, res) => {
  const event = store.eventBySlug(req.params.eventSlug);
  const channel = event && store.channelByEventAndName(event.id, req.params.channelName);
  if (!event || !channel) return res.status(404).send("Speaker page not found");
  sendAppPage(req, res, "speaker.html");
});

app.get("/e/:eventSlug/:channelName/listen", (req, res) => {
  const event = store.eventBySlug(req.params.eventSlug);
  const channel = event && store.channelByEventAndName(event.id, req.params.channelName);
  if (!event || !channel) return res.status(404).send("Listener page not found");
  sendAppPage(req, res, "listen.html");
});

app.get("/listener.html", (req, res) => {
  sendAppPage(req, res, "listen.html");
});

app.get("/speaker.html", (req, res) => {
  sendAppPage(req, res, "speaker.html");
});

app.get("/event-assets/:eventSlug/logo.png", (req, res) => {
  const event = store.eventBySlug(req.params.eventSlug);
  const logo = event && store.eventLogo(event.id);
  if (!logo || !existsSync(logo.storagePath)) return res.status(404).send("Logo not found");
  res.type("image/png").sendFile(logo.storagePath);
});

app.post("/api/auth/login", (req, res) => {
  const user = store.authenticate(req.body?.email, req.body?.password);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  setSession(res, user);
  res.json({ user: store.publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: store.publicUser(currentUser(req)) });
});

app.post("/api/auth/change-password", requireLogin, (req, res) => {
  if (!req.body?.password) return res.status(400).json({ error: "Password required" });
  store.setUserPassword(req.user.id, req.body.password);
  res.json({ ok: true });
});

app.patch("/api/auth/profile", requireLogin, (req, res) => {
  try {
    res.json({ user: store.updateUser(req.user.id, req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/users", requireAdmin, (_, res) => res.json({ users: store.listUsers() }));

app.post("/api/users", requireAdmin, (req, res) => {
  try {
    res.json({ user: store.createUser(req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/users/:id/password", requireAdmin, (req, res) => {
  try {
    store.setUserPassword(req.params.id, req.body?.password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/users/:id", requireAdmin, (req, res) => {
  try {
    res.json({ user: store.updateUser(req.params.id, req.body || {}, { allowRole: true }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/users/:id/disable", requireAdmin, (req, res) => {
  try {
    store.disableUser(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/events", requireLogin, (req, res) => {
  res.json({ events: store.listEventsFor(req.user) });
});

app.post("/api/events", requireAdmin, (req, res) => {
  try {
    const created = store.createEvent(req.body || {}, req.user);
    res.json(created);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/events/:eventId", requireEventAccess, (req, res) => {
  const event = store.eventById(req.params.eventId);
  res.json({ event, logoUrl: store.eventLogo(event.id) ? `/event-assets/${event.slug}/logo.png` : "/logo.svg" });
});

app.patch("/api/events/:eventId", requireEventAccess, (req, res) => {
  try {
    res.json({ event: store.updateEvent(req.params.eventId, req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/events/:eventId", requireAdmin, (req, res) => {
  try {
    store.archiveEvent(req.params.eventId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/events/:eventId/users", requireEventAccess, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin required" });
  res.json({ users: store.listAssignments(req.params.eventId) });
});

app.post("/api/events/:eventId/users", requireAdmin, (req, res) => {
  try {
    store.assignUser(req.params.eventId, req.body?.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/events/:eventId/users/:userId", requireAdmin, (req, res) => {
  store.unassignUser(req.params.eventId, req.params.userId);
  res.json({ ok: true });
});

app.post("/api/events/:eventId/logo", requireEventAccess, (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || "");
    const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "PNG data URL required" });
    const buffer = Buffer.from(match[1], "base64");
    if (buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: "Logo must be 2 MB or smaller" });
    if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
      return res.status(400).json({ error: "Logo must be a PNG" });
    }
    const event = store.eventById(req.params.eventId);
    const dir = path.join(uploadRoot, "events", event.id);
    mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, `logo-${Date.now()}.png`);
    writeFileSync(storagePath, buffer);
    const previous = store.eventLogo(event.id);
    const asset = store.setEventLogo(event.id, {
      originalFilename: req.body?.filename || "logo.png",
      mimeType: "image/png",
      storagePath,
      publicPath: `/event-assets/${event.slug}/logo.png`,
      sizeBytes: buffer.length,
      width: null,
      height: null,
      createdByUserId: req.user.id,
    });
    if (previous?.storagePath && existsSync(previous.storagePath)) unlinkSync(previous.storagePath);
    res.json({ asset });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/events/:eventId/logo", requireEventAccess, (req, res) => {
  const previous = store.eventLogo(req.params.eventId);
  store.removeEventLogo(req.params.eventId);
  if (previous?.storagePath && existsSync(previous.storagePath)) unlinkSync(previous.storagePath);
  res.json({ ok: true });
});

app.get("/api/events/:eventId/channels", requireEventAccess, (req, res) => {
  const channels = store.listChannels(req.params.eventId).map(channel => ({
    ...channel,
    speakerToken: undefined,
    listenerToken: undefined,
    hls: store.getHls(channel.id),
  }));
  res.json({ channels });
});

app.post("/api/events/:eventId/channels", requireEventAccess, (req, res) => {
  try {
    const channel = store.createChannel(req.params.eventId, req.body?.name);
    res.json({ channel, links: linksFor(req, channel) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/channels/:channelId", requireEventAccess, async (req, res) => {
  try {
    const channel = store.channelById(req.params.channelId);
    if (channel) await stopHls(channel);
    store.deleteChannel(req.params.channelId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/channels/:channelId/links", requireEventAccess, (req, res) => {
  const channel = store.channelById(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  res.json({ links: linksFor(req, channel) });
});

app.post("/api/channels/:channelId/tokens/:kind/refresh", requireEventAccess, (req, res) => {
  try {
    const token = store.refreshChannelToken(req.params.channelId, req.params.kind);
    const channel = store.channelById(req.params.channelId);
    res.json({ token, links: linksFor(req, channel), channel });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/channels/:channelId/qr/:role.svg", requireEventAccess, async (req, res) => {
  const channel = store.channelById(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  if (!["speaker", "listener"].includes(req.params.role)) return res.status(400).json({ error: "Invalid QR role" });
  const links = linksFor(req, channel);
  const url = req.params.role === "speaker" ? links.speaker : links.listener;
  res.type("image/svg+xml").send(await qrSvg(url));
});

app.get("/api/public/channel", (req, res) => {
  const event = store.eventBySlug(req.query.event);
  const channel = event && store.channelByEventAndName(event.id, req.query.channel);
  const role = String(req.query.role || "");
  if (!event || !channel || !store.verifyChannelToken(channel, role, req.query.token)) {
    return res.status(403).json({ error: "Invalid or expired link" });
  }
  res.json(channelContext(channel));
});

app.get("/api/livekit/token", async (req, res) => {
  const channel = store.channelById(req.query.channelId);
  const role = String(req.query.role || "");
  if (!channel || !store.verifyChannelToken(channel, role, req.query.token)) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
  const room = store.roomNameFor(channel);
  const jwt = await livekitToken(room, `${role}-${randomUUID().slice(0, 8)}`, role);
  res.json({ token: jwt, livekitUrl: livekitUrlFor(req), room });
});

app.get("/api/channels/:channelId/hls", (req, res) => {
  const channel = store.channelById(req.params.channelId);
  if (!channel || !store.verifyChannelToken(channel, "listener", req.query.token)) {
    return res.status(403).json({ error: "Invalid or expired listener token" });
  }
  const stream = store.getHls(channel.id);
  res.json({ active: Boolean(stream), url: stream?.playlistPath || null, status: stream?.status || "stopped" });
});

app.post("/api/channels/:channelId/hls/start", requireEventAccess, async (req, res) => {
  try {
    const channel = store.channelById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found" });
    res.json({ hls: await startHls(channel) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/channels/:channelId/hls/stop", requireEventAccess, async (req, res) => {
  const channel = store.channelById(req.params.channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  await stopHls(channel);
  res.json({ ok: true });
});

app.post("/api/channels/:channelId/speaker-session/start", async (req, res) => {
  try {
    const channel = store.channelById(req.params.channelId);
    if (!channel || !store.verifyChannelToken(channel, "speaker", req.query.token || req.body?.token)) {
      return res.status(403).json({ error: "Invalid or expired speaker token" });
    }
    res.json({ hls: await startHls(channel) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/channels/:channelId/speaker-session/stop", (_, res) => {
  res.json({ ok: true });
});

app.get("/health", (_, res) => res.json({ ok: true, publicWss, localWss }));

app.listen(8080, () => {
  console.log("lOudvoice web on :8080");
  console.log("  public WSS:", publicWss);
  console.log("  local  WSS:", localWss);
  console.log("  data:", dataPath);
});
