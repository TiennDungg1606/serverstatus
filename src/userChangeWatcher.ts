import type { ChangeStream, ChangeStreamDocument, ChangeStreamUpdateDocument, Document } from "mongodb";
import { MongoClient } from "mongodb";

const TRACKED_FIELDS = new Set([
  "firstName",
  "lastName",
  "username",
  "avatar",
  "goal33"
]);

type WatchedOperation = "insert" | "update" | "replace" | "delete";

const WATCHED_OPERATIONS = new Set<WatchedOperation>(["insert", "update", "replace", "delete"]);

export type PlayerDirectoryChange = {
  operationType: WatchedOperation;
  documentId: string | null;
};

export interface UserChangeWatcherHandle {
  stop: () => Promise<void>;
}

export interface UserChangeWatcherOptions {
  mongoUri: string;
  dbName?: string | null;
  collectionName?: string;
  logger?: Pick<typeof console, "info" | "warn" | "error">;
  onChange: (payload: PlayerDirectoryChange) => void | Promise<void>;
}

function normalizeDocumentId(documentKey: unknown): string | null {
  if (!documentKey || typeof documentKey !== "object") {
    return null;
  }
  const rawId = (documentKey as { _id?: unknown })._id;
  if (typeof rawId === "string") return rawId;
  if (rawId && typeof rawId === "object" && "toString" in rawId && typeof rawId.toString === "function") {
    try {
      return rawId.toString();
    } catch {
      return null;
    }
  }
  return null;
}

function getDbNameFromUri(uri: string, provided?: string | null): string | null {
  if (provided) return provided;
  const match = uri.match(/\/([^/?]+)(?:\?|$)/);
  return match?.[1] ?? null;
}

function shouldBroadcast(event: ChangeStreamDocument<Document>): event is ChangeStreamDocument<Document> {
  const op = event.operationType;
  if (op === "insert" || op === "delete" || op === "replace") {
    return true;
  }
  if (op === "update") {
    const updateEvent = event as ChangeStreamUpdateDocument<Document>;
    const updated = Object.keys(updateEvent.updateDescription?.updatedFields ?? {});
    const removed = updateEvent.updateDescription?.removedFields ?? [];
    if (updated.length === 0 && removed.length === 0) {
      return false;
    }
    return updated.some((field) => TRACKED_FIELDS.has(field)) || removed.some((field) => TRACKED_FIELDS.has(field));
  }
  return false;
}

export function startUserChangeWatcher(options: UserChangeWatcherOptions): UserChangeWatcherHandle | null {
  const { mongoUri, dbName, collectionName = "users", logger = console, onChange } = options;

  if (!mongoUri) {
    logger.warn("[userWatcher] mongoUri missing; watcher disabled");
    return null;
  }
  if (typeof onChange !== "function") {
    logger.warn("[userWatcher] onChange handler missing; watcher disabled");
    return null;
  }

  const resolvedDbName = getDbNameFromUri(mongoUri, dbName);
  if (!resolvedDbName) {
    logger.warn("[userWatcher] Could not determine database name");
    return null;
  }
  const databaseName: string = resolvedDbName;

  let stopped = false;
  let client: MongoClient | null = null;
  let stream: ChangeStream | null = null;

  const restartDelayMs = 5_000;

  async function closeStream() {
    if (stream) {
      try {
        await stream.close();
      } catch (error) {
        logger.error("[userWatcher] Failed to close change stream", error);
      }
      stream = null;
    }
    if (client) {
      try {
        await client.close();
      } catch (error) {
        logger.error("[userWatcher] Failed to close Mongo client", error);
      }
      client = null;
    }
  }

  function scheduleRestart() {
    closeStream().finally(() => {
      if (stopped) return;
      setTimeout(openStream, restartDelayMs).unref?.();
    });
  }

  async function openStream() {
    if (stopped) return;
    try {
      client = new MongoClient(mongoUri, {
        maxPoolSize: 1,
        serverSelectionTimeoutMS: 5_000
      });
      await client.connect();
      const db = client.db(databaseName);
      const collection = db.collection(collectionName);
      const pipeline = [
        { $match: { operationType: { $in: ["insert", "update", "replace", "delete"] } } },
        { $project: { operationType: 1, documentKey: 1, updateDescription: 1 } }
      ];
      stream = collection.watch(pipeline, { fullDocument: "default" });
      stream.on("change", async (event: ChangeStreamDocument<Document>) => {
        if (!shouldBroadcast(event)) {
          return;
        }
        const op = event.operationType;
        if (!WATCHED_OPERATIONS.has(op as WatchedOperation)) {
          return;
        }
        const documentId = normalizeDocumentId((event as { documentKey?: { _id?: unknown } }).documentKey);
        try {
          await onChange({ operationType: op as WatchedOperation, documentId });
        } catch (error) {
          logger.error("[userWatcher] onChange handler threw", error);
        }
      });
      stream.on("error", (error) => {
        logger.error("[userWatcher] Change stream error", error);
        scheduleRestart();
      });
      stream.on("close", () => {
        if (!stopped) {
          logger.warn("[userWatcher] Change stream closed; restarting");
          scheduleRestart();
        }
      });
      logger.info("[userWatcher] Listening for user collection changes");
    } catch (error) {
      logger.error("[userWatcher] Failed to open change stream", error);
      scheduleRestart();
    }
  }

  openStream();

  return {
    stop: async () => {
      stopped = true;
      await closeStream();
    }
  };
}
