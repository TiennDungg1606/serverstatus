import cors from "cors";
import type { CorsOptions } from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

import { config } from "./config.js";
import { InviteStore, type InviteRecord, type InviteStatus } from "./inviteStore.js";
import { PresenceStore } from "./presenceStore.js";
import type { PlayerDirectoryChange, UserChangeWatcherHandle } from "./userChangeWatcher.js";
import { startUserChangeWatcher } from "./userChangeWatcher.js";

const app = express();
const store = new PresenceStore(config.PRESENCE_TTL_MS);
const invites = new InviteStore();
const shouldLogPresence = Boolean(config.LOG_HEARTBEATS);
const playerDirectoryState = {
  version: 1,
  lastChangeAt: null as string | null,
  lastDocumentId: null as string | null
};
let playerDirectoryWatcherHandle: UserChangeWatcherHandle | null = null;

function logPresence(event: "heartbeat" | "offline", payload: Record<string, unknown>) {
  if (!shouldLogPresence) return;
  const timestamp = new Date().toISOString();
  console.info(`[presence][${event}] ${timestamp}`, payload);
}

function applyPlayerDirectoryChange(change: PlayerDirectoryChange) {
  playerDirectoryState.version += 1;
  playerDirectoryState.lastDocumentId = change.documentId ?? null;
  playerDirectoryState.lastChangeAt = new Date().toISOString();
  console.info("[playerDirectory] change detected", {
    version: playerDirectoryState.version,
    lastDocumentId: playerDirectoryState.lastDocumentId,
    operationType: change.operationType
  });
}

function startPlayerDirectoryWatcher() {
  if (!config.ENABLE_USER_WATCHER) {
    return;
  }
  if (!config.MONGODB_URI) {
    console.warn("[playerDirectory] ENABLE_USER_WATCHER is true but MONGODB_URI is missing");
    return;
  }
  playerDirectoryWatcherHandle = startUserChangeWatcher({
    mongoUri: config.MONGODB_URI,
    dbName: config.MONGODB_DB,
    logger: console,
    onChange: async (change) => {
      applyPlayerDirectoryChange(change);
    }
  });
}

async function stopPlayerDirectoryWatcher() {
  if (!playerDirectoryWatcherHandle) return;
  try {
    await playerDirectoryWatcherHandle.stop();
  } catch (error) {
    console.error("[playerDirectory] Failed to stop watcher", error);
  } finally {
    playerDirectoryWatcherHandle = null;
  }
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || config.allowedOrigins.length === 0) {
      callback(null, origin ?? "*");
      return;
    }

    if (config.allowedOrigins.includes(origin)) {
      callback(null, origin);
    } else {
      callback(new Error("Origin not allowed"));
    }
  }
};

app.use(cors(corsOptions));

const heartbeatSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(["online", "away", "busy"]).default("online"),
  ttlMs: z.number().int().positive().optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
});

const inviteSchema = z.object({
  requesterId: z.string().min(1),
  requesterDisplayName: z.string().min(1),
  requesterAvatar: z.string().optional().nullable(),
  requesterGoal33: z.string().optional().nullable(),
  targetUserId: z.string().min(1),
  targetDisplayName: z.string().min(1),
  targetAvatar: z.string().optional().nullable(),
  targetGoal33: z.string().optional().nullable()
});

const inviteDirectionSchema = z.enum(["incoming", "outgoing", "all"]).default("outgoing");
const inviteStatusSchema = z.enum(["pending", "accepted", "declined"]).default("pending");
const inviteStatusUpdateSchema = z.object({
  status: z.enum(["accepted", "declined"] as const),
  actorUserId: z.string().min(1)
});

function serializeInvite(record: InviteRecord, perspectiveUserId: string) {
  const direction = record.fromUserId === perspectiveUserId ? "outgoing" : "incoming";
  const peer =
    direction === "outgoing"
      ? {
          userId: record.toUserId,
          displayName: record.toDisplayName,
          avatar: record.toAvatar ?? null,
          goal33: record.toGoal33 ?? null
        }
      : {
          userId: record.fromUserId,
          displayName: record.fromDisplayName,
          avatar: record.fromAvatar ?? null,
          goal33: record.fromGoal33 ?? null
        };

  return {
    id: record.id,
    direction,
    status: record.status,
    createdAt: record.createdAt,
    fromUserId: record.fromUserId,
    fromDisplayName: record.fromDisplayName,
    fromAvatar: record.fromAvatar ?? null,
    fromGoal33: record.fromGoal33 ?? null,
    toUserId: record.toUserId,
    toDisplayName: record.toDisplayName,
    toAvatar: record.toAvatar ?? null,
    toGoal33: record.toGoal33 ?? null,
    peer
  };
}

async function syncFriendship(record: InviteRecord) {
  if (!config.FRIEND_SYNC_URL) return;
  try {
    const response = await fetch(config.FRIEND_SYNC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.PRESENCE_SECRET ? { "x-presence-secret": config.PRESENCE_SECRET } : {})
      },
      body: JSON.stringify({
        fromUserId: record.fromUserId,
        toUserId: record.toUserId
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("Friend sync failed", response.status, text);
    }
  } catch (error) {
    console.error("Friend sync request errored", error);
  }
}

const idsSchema = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  )
  .pipe(z.array(z.string().min(1)));

function requireSecret(req: Request, res: Response, next: NextFunction) {
  if (!config.PRESENCE_SECRET) {
    next();
    return;
  }

  const headerSecret = req.header("x-presence-secret");
  if (!headerSecret || headerSecret !== config.PRESENCE_SECRET) {
    res.status(401).json({ message: "Missing or invalid presence secret" });
    return;
  }

  next();
}

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    activeUsers: store.size()
  });
});

app.post("/presence/heartbeat", requireSecret, (req, res) => {
  const parseResult = heartbeatSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ message: "Invalid payload", issues: parseResult.error.flatten() });
    return;
  }

  const payload = parseResult.data;
  const record = store.upsert(payload.userId, payload.status, {
    ttlMs: payload.ttlMs,
    metadata: payload.metadata
  });

  logPresence("heartbeat", {
    userId: record.userId,
    status: record.status,
    ttlMs: record.ttlMs,
    activeUsers: store.size()
  });

  res.json({
    userId: record.userId,
    status: record.status,
    ttlMs: record.ttlMs,
    lastSeen: record.lastSeen,
    metadata: record.metadata
  });
});

app.post("/presence/offline", requireSecret, (req, res) => {
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  if (!userId) {
    res.status(400).json({ message: "userId is required" });
    return;
  }

  store.markOffline(userId);
  logPresence("offline", { userId, activeUsers: store.size() });
  res.status(204).send();
});

app.get("/presence", (req, res) => {
  const userIdsRaw = req.query.userIds;
  if (!userIdsRaw || typeof userIdsRaw !== "string") {
    res.status(400).json({ message: "Provide userIds query param" });
    return;
  }

  const parsed = idsSchema.safeParse(userIdsRaw);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid userIds", issues: parsed.error.flatten() });
    return;
  }

  const records = store.getMany(parsed.data);
  res.json({
    users: records.map((record) => ({
      userId: record.userId,
      status: record.isOnline ? record.status : "offline",
      lastSeen: record.lastSeen,
      metadata: record.metadata ?? null
    }))
  });
});

app.get("/presence/:userId", (req, res) => {
  const userId = req.params.userId;
  const record = store.getOne(userId);
  if (!record) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json({
    userId: record.userId,
    status: record.isOnline ? record.status : "offline",
    lastSeen: record.lastSeen,
    ttlMs: record.ttlMs,
    metadata: record.metadata ?? null
  });
});

app.get("/players/directory/status", (req, res) => {
  const sinceParam = typeof req.query.since === "string" ? Number(req.query.since) : undefined;
  const sinceVersion = Number.isFinite(sinceParam) ? Number(sinceParam) : undefined;
  const currentVersion = playerDirectoryState.version;
  const changed = typeof sinceVersion === "number" ? currentVersion > sinceVersion : false;
  res.json({
    version: currentVersion,
    changed,
    lastChangeAt: playerDirectoryState.lastChangeAt,
    lastDocumentId: playerDirectoryState.lastDocumentId
  });
});

app.get("/friends/invites", requireSecret, (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
  if (!userId) {
    res.status(400).json({ message: "userId is required" });
    return;
  }

  const directionParam = typeof req.query.direction === "string" ? req.query.direction : undefined;
  const directionResult = inviteDirectionSchema.safeParse(directionParam ?? "outgoing");
  if (!directionResult.success) {
    res.status(400).json({ message: "Invalid direction" });
    return;
  }

  const statusParam = typeof req.query.status === "string" ? req.query.status : "pending";
  const statusResult = inviteStatusSchema.safeParse(statusParam ?? "pending");
  if (!statusResult.success) {
    res.status(400).json({ message: "Invalid status" });
    return;
  }

  const direction = directionResult.data;
  const status = statusResult.data;
  const records = invites.listForUser(userId, direction, [status]);
  res.json({
    invites: records.map((record) => serializeInvite(record, userId))
  });
});

app.post("/friends/invite", requireSecret, (req, res) => {
  const parseResult = inviteSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ message: "Invalid payload", issues: parseResult.error.flatten() });
    return;
  }

  const payload = parseResult.data;
  const record = invites.createInvite({
    fromUserId: payload.requesterId,
    fromDisplayName: payload.requesterDisplayName,
    fromAvatar: payload.requesterAvatar ?? null,
    fromGoal33: payload.requesterGoal33 ?? null,
    toUserId: payload.targetUserId,
    toDisplayName: payload.targetDisplayName,
    toAvatar: payload.targetAvatar ?? null,
    toGoal33: payload.targetGoal33 ?? null
  });

  const outgoing = invites.listForUser(payload.requesterId, "outgoing");
  res.json({
    invite: serializeInvite(record, payload.requesterId),
    invites: outgoing.map((item) => serializeInvite(item, payload.requesterId))
  });
});

app.post("/friends/invite/:inviteId/status", requireSecret, async (req, res) => {
  const inviteId = req.params.inviteId;
  if (!inviteId) {
    res.status(400).json({ message: "inviteId is required" });
    return;
  }

  const parseResult = inviteStatusUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ message: "Invalid payload", issues: parseResult.error.flatten() });
    return;
  }

  const data = parseResult.data;
  const record = invites.getById(inviteId);
  if (!record) {
    res.status(404).json({ message: "Invite not found" });
    return;
  }

  if (record.fromUserId !== data.actorUserId && record.toUserId !== data.actorUserId) {
    res.status(403).json({ message: "Actor is not part of invite" });
    return;
  }

  const updated = invites.updateStatus(inviteId, data.status as InviteStatus);
  if (!updated) {
    res.status(500).json({ message: "Failed to update invite" });
    return;
  }

  if (data.status === "accepted") {
    await syncFriendship(updated);
  }

  res.json({ invite: serializeInvite(updated, data.actorUserId) });
});

setInterval(() => {
  const removed = store.cleanupExpired();
  if (removed > 0) {
    console.info(`Cleaned ${removed} expired presence entries`);
  }
}, config.CLEANUP_INTERVAL_MS).unref();

startPlayerDirectoryWatcher();

const port = config.PORT;
const server = app.listen(port, () => {
  console.log(`Presence service listening on port ${port}`);
});

async function gracefulShutdown(signal: string) {
  console.info(`[shutdown] Received ${signal}, cleaning up...`);
  await stopPlayerDirectoryWatcher();
  server.close(() => {
    process.exit(0);
  });
}

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => void gracefulShutdown(signal));
});
