import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "crypto";

const now = () => new Date().toISOString();

function token() {
  return randomBytes(24).toString("base64url");
}

function hashSecret(secret) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(secret, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifySecret(secret, stored) {
  const [algorithm, salt, hash] = String(stored || "").split(":");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const candidate = Buffer.from(scryptSync(secret, salt, 64).toString("hex"));
  const expected = Buffer.from(hash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function tokenHint(value) {
  return value ? value.slice(0, 6) + "..." + value.slice(-4) : "";
}

function channelRoomName(event, channel) {
  return `${event.slug}-${channel.name}`.toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "event";
}

export class Store {
  constructor(filePath, seed = {}) {
    this.filePath = filePath;
    this.seed = seed;
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.data = this.load();
  }

  load() {
    if (existsSync(this.filePath)) {
      const data = JSON.parse(readFileSync(this.filePath, "utf8"));
      let migrated = false;
      for (const user of data.users || []) {
        if (!user.email && user.username) {
          user.email = user.username;
          migrated = true;
        }
        if (!user.username && user.email) {
          user.username = user.email;
          migrated = true;
        }
      }
      if (migrated) this.write(data);
      return data;
    }

    const adminPassword = this.seed.adminPassword || "admin";
    const adminEmail = this.seed.adminEmail || "admin@example.com";
    const eventId = randomUUID();
    const adminId = randomUUID();
    const channelId = randomUUID();
    const speakerToken = token();
    const listenerToken = token();
    const data = {
      version: 1,
      users: [{
        id: adminId,
        email: adminEmail,
        username: adminEmail,
        passwordHash: hashSecret(adminPassword),
        role: "admin",
        displayName: "Admin",
        createdAt: now(),
        updatedAt: now(),
        disabledAt: null,
      }],
      events: [{
        id: eventId,
        name: "Default Event",
        slug: "default-event",
        description: "",
        publicDescription: "Live audio for this event.",
        location: "",
        logoAssetId: null,
        startsAt: null,
        endsAt: null,
        createdByUserId: adminId,
        createdAt: now(),
        updatedAt: now(),
        archivedAt: null,
      }],
      eventUsers: [],
      channels: [{
        id: channelId,
        eventId,
        name: "EN",
        speakerTokenHash: hashSecret(speakerToken),
        listenerTokenHash: hashSecret(listenerToken),
        speakerToken,
        listenerToken,
        speakerTokenHint: tokenHint(speakerToken),
        listenerTokenHint: tokenHint(listenerToken),
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      }],
      assets: [],
      hlsStreams: [],
      auditLog: [],
    };
    data.initialLinks = { speakerToken, listenerToken };
    this.write(data);
    return data;
  }

  write(data = this.data) {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  save() {
    this.write();
  }

  publicUser(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
  }

  authenticate(email, password) {
    const normalized = String(email || "").trim().toLowerCase();
    const user = this.data.users.find(u => String(u.email || u.username || "").toLowerCase() === normalized && !u.disabledAt);
    if (!user || !verifySecret(password, user.passwordHash)) return null;
    user.lastAccessed = now();
    this.save();
    return user;
  }

  userById(id) {
    return this.data.users.find(u => u.id === id && !u.disabledAt) || null;
  }

  listUsers() {
    return this.data.users.filter(u => !u.disabledAt).map(u => this.publicUser(u));
  }

  createUser({ email, password, role, displayName }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !password) throw new Error("Email and password are required");
    if (!["admin", "event_manager"].includes(role)) throw new Error("Invalid role");
    if (this.data.users.some(u => String(u.email || u.username || "").toLowerCase() === normalizedEmail && !u.disabledAt)) {
      throw new Error("Email already exists");
    }
    const user = {
      id: randomUUID(),
      email: normalizedEmail,
      username: normalizedEmail,
      passwordHash: hashSecret(password),
      role,
      displayName: displayName || normalizedEmail,
      createdAt: now(),
      updatedAt: now(),
      lastAccessed: null,
      disabledAt: null,
    };
    this.data.users.push(user);
    this.save();
    return this.publicUser(user);
  }

  setUserPassword(id, password) {
    const user = this.userById(id);
    if (!user) throw new Error("User not found");
    if (!password) throw new Error("Password required");
    user.passwordHash = hashSecret(password);
    user.updatedAt = now();
    this.save();
  }

  updateUser(id, changes, { allowRole = false } = {}) {
    const user = this.userById(id);
    if (!user) throw new Error("User not found");
    const email = changes.email !== undefined ? String(changes.email || "").trim().toLowerCase() : user.email || user.username;
    if (!email) throw new Error("Email is required");
    if (this.data.users.some(u => u.id !== id && String(u.email || u.username || "").toLowerCase() === email && !u.disabledAt)) {
      throw new Error("Email already exists");
    }
    user.email = email;
    user.username = email;
    if (changes.displayName !== undefined) {
      user.displayName = String(changes.displayName || email).trim() || email;
    }
    if (allowRole && changes.role !== undefined) {
      if (!["admin", "event_manager"].includes(changes.role)) throw new Error("Invalid role");
      user.role = changes.role;
    }
    user.updatedAt = now();
    this.save();
    return this.publicUser(user);
  }

  disableUser(id) {
    const user = this.userById(id);
    if (!user) throw new Error("User not found");
    user.disabledAt = now();
    this.save();
  }

  listEventsFor(user) {
    const active = this.data.events.filter(e => !e.archivedAt);
    if (user.role === "admin") return active;
    const allowed = new Set(this.data.eventUsers.filter(eu => eu.userId === user.id).map(eu => eu.eventId));
    return active.filter(event => allowed.has(event.id));
  }

  eventById(id) {
    return this.data.events.find(e => e.id === id && !e.archivedAt) || null;
  }

  eventBySlug(slug) {
    return this.data.events.find(e => e.slug === slug && !e.archivedAt) || null;
  }

  canManageEvent(user, eventId) {
    if (!user) return false;
    if (user.role === "admin") return true;
    return this.data.eventUsers.some(eu => eu.userId === user.id && eu.eventId === eventId);
  }

  createEvent({ name, publicDescription = "", location = "" }, actor) {
    if (!name) throw new Error("Event name is required");
    const baseSlug = slugify(name);
    let slug = baseSlug;
    let suffix = 2;
    while (this.data.events.some(e => e.slug === slug && !e.archivedAt)) {
      slug = `${baseSlug}-${suffix++}`;
    }
    const event = {
      id: randomUUID(),
      name,
      slug,
      description: "",
      publicDescription,
      location,
      logoAssetId: null,
      startsAt: null,
      endsAt: null,
      createdByUserId: actor?.id || null,
      createdAt: now(),
      updatedAt: now(),
      archivedAt: null,
    };
    this.data.events.push(event);
    const channel = this.createChannelRecord(event.id, "EN");
    this.save();
    return { event, initialChannel: channel };
  }

  updateEvent(id, changes) {
    const event = this.eventById(id);
    if (!event) throw new Error("Event not found");
    for (const key of ["name", "publicDescription", "location", "description"]) {
      if (changes[key] !== undefined) event[key] = String(changes[key] || "");
    }
    event.updatedAt = now();
    this.save();
    return event;
  }

  archiveEvent(id) {
    const event = this.eventById(id);
    if (!event) throw new Error("Event not found");
    event.archivedAt = now();
    this.save();
  }

  listAssignments(eventId) {
    const assigned = new Set(this.data.eventUsers.filter(eu => eu.eventId === eventId).map(eu => eu.userId));
    return this.listUsers().map(user => ({ ...user, assigned: assigned.has(user.id) }));
  }

  assignUser(eventId, userId) {
    if (!this.eventById(eventId)) throw new Error("Event not found");
    if (!this.userById(userId)) throw new Error("User not found");
    if (!this.data.eventUsers.some(eu => eu.eventId === eventId && eu.userId === userId)) {
      this.data.eventUsers.push({ eventId, userId, permission: "manager", createdAt: now() });
      this.save();
    }
  }

  unassignUser(eventId, userId) {
    this.data.eventUsers = this.data.eventUsers.filter(eu => !(eu.eventId === eventId && eu.userId === userId));
    this.save();
  }

  createChannelRecord(eventId, name) {
    const speakerToken = token();
    const listenerToken = token();
    const channel = {
      id: randomUUID(),
      eventId,
      name: String(name || "").trim().toUpperCase(),
      speakerTokenHash: hashSecret(speakerToken),
      listenerTokenHash: hashSecret(listenerToken),
      speakerToken,
      listenerToken,
      speakerTokenHint: tokenHint(speakerToken),
      listenerTokenHint: tokenHint(listenerToken),
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    };
    this.data.channels.push(channel);
    return channel;
  }

  createChannel(eventId, name) {
    if (!this.eventById(eventId)) throw new Error("Event not found");
    const normalized = String(name || "").trim().toUpperCase();
    if (!normalized) throw new Error("Channel name is required");
    if (this.listChannels(eventId).some(c => c.name === normalized)) {
      throw new Error("Channel already exists");
    }
    const channel = this.createChannelRecord(eventId, normalized);
    this.save();
    return channel;
  }

  listChannels(eventId) {
    return this.data.channels.filter(c => c.eventId === eventId && !c.deletedAt);
  }

  channelById(id) {
    return this.data.channels.find(c => c.id === id && !c.deletedAt) || null;
  }

  channelByEventAndName(eventId, name) {
    const normalized = String(name || "").trim().toUpperCase();
    return this.data.channels.find(c => c.eventId === eventId && c.name === normalized && !c.deletedAt) || null;
  }

  deleteChannel(id) {
    const channel = this.channelById(id);
    if (!channel) throw new Error("Channel not found");
    channel.deletedAt = now();
    this.save();
  }

  refreshChannelToken(id, kind) {
    const channel = this.channelById(id);
    if (!channel) throw new Error("Channel not found");
    const next = token();
    if (kind === "speaker") {
      channel.speakerTokenHash = hashSecret(next);
      channel.speakerToken = next;
      channel.speakerTokenHint = tokenHint(next);
    } else if (kind === "listener") {
      channel.listenerTokenHash = hashSecret(next);
      channel.listenerToken = next;
      channel.listenerTokenHint = tokenHint(next);
    } else {
      throw new Error("Invalid token type");
    }
    channel.updatedAt = now();
    this.save();
    return next;
  }

  verifyChannelToken(channel, role, suppliedToken) {
    if (!channel || !suppliedToken) return false;
    if (role === "speak" || role === "speaker") return verifySecret(suppliedToken, channel.speakerTokenHash);
    if (role === "listen" || role === "listener") return verifySecret(suppliedToken, channel.listenerTokenHash);
    return false;
  }

  setEventLogo(eventId, asset) {
    const event = this.eventById(eventId);
    if (!event) throw new Error("Event not found");
    const record = {
      id: randomUUID(),
      ownerEventId: eventId,
      kind: "event_logo",
      ...asset,
      createdAt: now(),
      deletedAt: null,
    };
    if (event.logoAssetId) {
      const old = this.data.assets.find(a => a.id === event.logoAssetId);
      if (old) old.deletedAt = now();
    }
    this.data.assets.push(record);
    event.logoAssetId = record.id;
    event.updatedAt = now();
    this.save();
    return record;
  }

  assetById(id) {
    return this.data.assets.find(a => a.id === id && !a.deletedAt) || null;
  }

  eventLogo(eventId) {
    const event = this.eventById(eventId);
    return event?.logoAssetId ? this.assetById(event.logoAssetId) : null;
  }

  removeEventLogo(eventId) {
    const event = this.eventById(eventId);
    if (!event) throw new Error("Event not found");
    const asset = this.assetById(event.logoAssetId);
    if (asset) asset.deletedAt = now();
    event.logoAssetId = null;
    event.updatedAt = now();
    this.save();
  }

  getHls(channelId) {
    return this.data.hlsStreams.find(h => h.channelId === channelId && ["starting", "active"].includes(h.status)) || null;
  }

  setHls(channelId, stream) {
    this.data.hlsStreams = this.data.hlsStreams.filter(h => !(h.channelId === channelId && ["starting", "active"].includes(h.status)));
    this.data.hlsStreams.push({
      id: randomUUID(),
      channelId,
      ...stream,
      startedAt: now(),
      stoppedAt: null,
    });
    this.save();
    return this.getHls(channelId);
  }

  stopHls(channelId, errorMessage = "") {
    const stream = this.getHls(channelId);
    if (stream) {
      stream.status = errorMessage ? "failed" : "stopped";
      stream.errorMessage = errorMessage;
      stream.stoppedAt = now();
      this.save();
    }
    return stream;
  }

  roomNameFor(channel) {
    const event = this.eventById(channel.eventId);
    return channelRoomName(event, channel);
  }
}
