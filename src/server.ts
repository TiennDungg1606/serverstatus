import cors from "cors";
import type { CorsOptions } from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

import { config } from "./config.js";
import { PresenceStore } from "./presenceStore.js";

const app = express();
const store = new PresenceStore(config.PRESENCE_TTL_MS);
const shouldLogPresence = Boolean(config.LOG_HEARTBEATS);

function logPresence(event: "heartbeat" | "offline", payload: Record<string, unknown>) {
  if (!shouldLogPresence) return;
  const timestamp = new Date().toISOString();
  console.info(`[presence][${event}] ${timestamp}`, payload);
}

app.use(express.json());

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

setInterval(() => {
  const removed = store.cleanupExpired();
  if (removed > 0) {
    console.info(`Cleaned ${removed} expired presence entries`);
  }
}, config.CLEANUP_INTERVAL_MS).unref();

const port = config.PORT;
app.listen(port, () => {
  console.log(`Presence service listening on port ${port}`);
});
