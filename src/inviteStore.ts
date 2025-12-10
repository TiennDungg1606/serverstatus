import { randomUUID } from "crypto";

export type InviteStatus = "pending" | "accepted" | "declined";

export interface InviteRecord {
  id: string;
  fromUserId: string;
  fromDisplayName: string;
  fromAvatar?: string | null;
  fromGoal33?: string | null;
  toUserId: string;
  toDisplayName: string;
  toAvatar?: string | null;
  toGoal33?: string | null;
  status: InviteStatus;
  createdAt: number;
}

export type InviteDirection = "incoming" | "outgoing" | "all";

export class InviteStore {
  private readonly invites = new Map<string, InviteRecord>();

  createInvite(payload: {
    fromUserId: string;
    fromDisplayName: string;
    fromAvatar?: string | null;
    fromGoal33?: string | null;
    toUserId: string;
    toDisplayName: string;
    toAvatar?: string | null;
    toGoal33?: string | null;
  }): InviteRecord {
    const existing = Array.from(this.invites.values()).find(
      (invite) =>
        invite.status === "pending" &&
        invite.fromUserId === payload.fromUserId &&
        invite.toUserId === payload.toUserId
    );

    if (existing) {
      return existing;
    }

    const record: InviteRecord = {
      id: randomUUID(),
      fromUserId: payload.fromUserId,
      fromDisplayName: payload.fromDisplayName,
      fromAvatar: payload.fromAvatar ?? null,
      fromGoal33: payload.fromGoal33 ?? null,
      toUserId: payload.toUserId,
      toDisplayName: payload.toDisplayName,
      toAvatar: payload.toAvatar ?? null,
      toGoal33: payload.toGoal33 ?? null,
      status: "pending",
      createdAt: Date.now()
    };

    this.invites.set(record.id, record);
    return record;
  }

  getById(inviteId: string): InviteRecord | undefined {
    return this.invites.get(inviteId);
  }

  listForUser(
    userId: string,
    direction: InviteDirection = "incoming",
    statusFilter: InviteStatus[] = ["pending"]
  ): InviteRecord[] {
    return Array.from(this.invites.values())
      .filter((invite) => {
        if (!statusFilter.includes(invite.status)) {
          return false;
        }
        if (direction === "incoming") {
          return invite.toUserId === userId;
        }
        if (direction === "outgoing") {
          return invite.fromUserId === userId;
        }
        return invite.fromUserId === userId || invite.toUserId === userId;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  updateStatus(inviteId: string, status: InviteStatus): InviteRecord | undefined {
    const record = this.invites.get(inviteId);
    if (!record) return undefined;

    record.status = status;
    return record;
  }

  delete(inviteId: string): boolean {
    return this.invites.delete(inviteId);
  }
}
