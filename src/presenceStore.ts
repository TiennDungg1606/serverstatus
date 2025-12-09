export type PresenceStatus = "online" | "away" | "busy";

export interface PresenceRecord {
  userId: string;
  status: PresenceStatus;
  lastSeen: number;
  expiresAt: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface PresenceSnapshot extends PresenceRecord {
  isOnline: boolean;
  ttlMs: number;
}

export class PresenceStore {
  private readonly ttlMs: number;
  private readonly store = new Map<string, PresenceRecord>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  upsert(
    userId: string,
    status: PresenceStatus,
    overrides?: {
      ttlMs?: number;
      metadata?: PresenceRecord["metadata"];
    }
  ): PresenceSnapshot {
    const now = Date.now();
    const effectiveTtl = Math.max(1_000, overrides?.ttlMs ?? this.ttlMs);
    const expiresAt = now + effectiveTtl;
    const record: PresenceRecord = {
      userId,
      status,
      lastSeen: now,
      expiresAt,
      metadata: overrides?.metadata
    };

    this.store.set(userId, record);
    return this.toSnapshot(record);
  }

  markOffline(userId: string): void {
    this.store.delete(userId);
  }

  getOne(userId: string): PresenceSnapshot | undefined {
    const record = this.store.get(userId);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.store.delete(userId);
      return undefined;
    }

    return this.toSnapshot(record);
  }

  getMany(userIds: string[]): PresenceSnapshot[] {
    const deduped = Array.from(new Set(userIds));
    return deduped
      .map((userId) => this.getOne(userId))
      .filter((record): record is PresenceSnapshot => Boolean(record));
  }

  cleanupExpired(): number {
    let removed = 0;
    for (const [userId, record] of this.store.entries()) {
      if (this.isExpired(record)) {
        this.store.delete(userId);
        removed += 1;
      }
    }

    return removed;
  }

  size(): number {
    return this.store.size;
  }

  private isExpired(record: PresenceRecord): boolean {
    return record.expiresAt <= Date.now();
  }

  private toSnapshot(record: PresenceRecord): PresenceSnapshot {
    const ttlMs = Math.max(0, record.expiresAt - Date.now());
    return {
      ...record,
      ttlMs,
      isOnline: ttlMs > 0
    };
  }
}
