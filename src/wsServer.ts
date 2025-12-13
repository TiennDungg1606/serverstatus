// @ts-ignore
import { WebSocketServer, WebSocket } from "ws";
import { PresenceStatus } from "./presenceStore.js";
import { config } from "./config.js";
import { store } from "./server.js";

const wss = new WebSocketServer({ port: (config as any).WS_PORT || 8081 });

// Subscription manager: track which connections are subscribed to which friends
type Subscription = {
  ws: WebSocket;
  friendIds: Set<string>;
};

const subscriptions = new Map<WebSocket, Subscription>();

// Helper to notify subscribers when a friend's presence changes
function notifySubscribers(friendId: string, status: "online" | "away" | "busy" | "offline", lastSeen: number) {
  const update = {
    type: "friends-presence-update",
    users: [{
      userId: friendId,
      status,
      lastSeen,
      metadata: null
    }]
  };

  for (const [ws, sub] of subscriptions.entries()) {
    if (sub.friendIds.has(friendId) && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(update));
      } catch (e) {
        // Connection closed, remove subscription
        subscriptions.delete(ws);
      }
    }
  }
}

wss.on("connection", (ws: WebSocket) => {
  let userId: string | null = null;

  ws.on("message", (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "heartbeat" && msg.userId) {
        userId = msg.userId;
        const status: PresenceStatus = msg.status || "online";
        if (typeof userId === "string") {
          const record = store.upsert(userId, status, { ttlMs: msg.ttlMs || 60000, metadata: msg.metadata || {} });
          ws.send(JSON.stringify({ type: "heartbeat-ack", userId }));
          // Notify subscribers that this user is online
          notifySubscribers(userId, record.isOnline ? record.status : "offline", record.lastSeen);
        }
      } else if (msg.type === "offline" && msg.userId) {
        userId = msg.userId;
        if (typeof userId === "string") {
          const record = store.getOne(userId);
          const lastSeen = record?.lastSeen || Date.now();
          store.markOffline(userId);
          // Notify subscribers that this user is offline
          notifySubscribers(userId, "offline", lastSeen);
        }
      } else if (msg.type === "query-presence" && Array.isArray(msg.userIds)) {
        // Query presence for multiple userIds via WebSocket (optimized: 5s timeout)
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
        // Subscribe to friends presence updates with realtime notifications
        const friendIds = msg.friendIds.filter((id: any): id is string => typeof id === "string");
        
        // Track subscription
        const sub = subscriptions.get(ws);
        if (sub) {
          // Update existing subscription
          sub.friendIds = new Set(friendIds);
        } else {
          // Create new subscription
          subscriptions.set(ws, { ws, friendIds: new Set(friendIds) });
        }
        
        // Send initial presence data immediately
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
      } else if (msg.type === "unsubscribe-friends") {
        // Unsubscribe from friends updates
        subscriptions.delete(ws);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", error: "Invalid message" }));
    }
  });

  ws.on("close", () => {
    // Remove subscription when connection closes
    subscriptions.delete(ws);
    
    if (userId != null) {
      const record = store.getOne(userId);
      const lastSeen = record?.lastSeen || Date.now();
      store.markOffline(userId as string);
      // Notify subscribers that this user is offline
      notifySubscribers(userId, "offline", lastSeen);
    }
  });
});

console.log(`WebSocket presence server listening on port ${(config as any).WS_PORT || 8081}`);
