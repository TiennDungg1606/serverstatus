// @ts-ignore
import { WebSocketServer, WebSocket } from "ws";
import { PresenceStatus } from "./presenceStore.js";
import { config } from "./config.js";
import { store } from "./server.js";

const wss = new WebSocketServer({ port: (config as any).WS_PORT || 8081 });

wss.on("connection", (ws: WebSocket) => {
  let userId: string | null = null;

  ws.on("message", (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "heartbeat" && msg.userId) {
        userId = msg.userId;
        const status: PresenceStatus = msg.status || "online";
        if (typeof userId === "string") {
          store.upsert(userId, status, { ttlMs: msg.ttlMs || 60000, metadata: msg.metadata || {} });
          ws.send(JSON.stringify({ type: "heartbeat-ack", userId }));
        }
      } else if (msg.type === "offline" && msg.userId) {
        userId = msg.userId;
        if (typeof userId === "string") {
          store.markOffline(userId);
        }
      } else if (msg.type === "query-presence" && Array.isArray(msg.userIds)) {
        // Query presence for multiple userIds via WebSocket
        const userIds = msg.userIds.filter((id: any): id is string => typeof id === "string");
        const records = store.getMany(userIds);
        ws.send(JSON.stringify({
          type: "presence-response",
          requestId: msg.requestId,
          users: records.map((record) => ({
            userId: record.userId,
            status: record.isOnline ? record.status : "offline",
            lastSeen: record.lastSeen,
            metadata: record.metadata ?? null
          }))
        }));
      } else if (msg.type === "subscribe-friends" && Array.isArray(msg.friendIds)) {
        // Subscribe to friends presence updates
        // Store subscription in connection (simplified - in production might want a proper subscription manager)
        const friendIds = msg.friendIds.filter((id: any): id is string => typeof id === "string");
        // Send initial presence data
        const records = store.getMany(friendIds);
        ws.send(JSON.stringify({
          type: "friends-presence-update",
          users: records.map((record) => ({
            userId: record.userId,
            status: record.isOnline ? record.status : "offline",
            lastSeen: record.lastSeen,
            metadata: record.metadata ?? null
          }))
        }));
        // TODO: In production, implement proper subscription tracking to send updates when friends come online/offline
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: "Invalid message" }));
    }
  });

  ws.on("close", () => {
    if (userId != null) {
      store.markOffline(userId as string);
    }
  });
});

console.log(`WebSocket presence server listening on port ${(config as any).WS_PORT || 8081}`);
