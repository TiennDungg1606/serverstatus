// @ts-ignore
import { WebSocketServer, WebSocket } from "ws";
import { PresenceStore, PresenceStatus } from "./presenceStore.js";
import { config } from "./config.js";

const wss = new WebSocketServer({ port: (config as any).WS_PORT || 8081 });
const store = new PresenceStore((config as any).PRESENCE_TTL_MS);

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
      }
      // Có thể mở rộng: nhận subscribe friends, v.v.
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
