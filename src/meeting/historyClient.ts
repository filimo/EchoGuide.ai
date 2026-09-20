import { meetingRequest } from "./client";
import { isMeetingCardSnapshot, type MeetingCardSnapshot } from "./history";

// Writes survive selection changes. Retain failed snapshots for retry during this page lifetime.
const pending = new Map<string, MeetingCardSnapshot>();
let queue: Promise<void> = Promise.resolve();
function id(r: MeetingCardSnapshot) { return `${r.attemptId}:${r.sequence}`; }
export const meetingHistoryClient = {
  async save(record: MeetingCardSnapshot): Promise<void> {
    pending.set(id(record), record);
    const task = queue.catch(() => {}).then(async () => {
      await meetingRequest("history/save", { record });
      pending.delete(id(record));
    });
    queue = task;
    return task;
  },
  async load(sessionId: string): Promise<MeetingCardSnapshot[]> {
    await queue.catch(() => {});
    const response = await meetingRequest<{ snapshots: MeetingCardSnapshot[] }>("history/read", { sessionId });
    if (!Array.isArray(response.snapshots) || !response.snapshots.every(isMeetingCardSnapshot)) throw new Error("Invalid history response");
    const merged = new Map(response.snapshots.map(r => [id(r), r]));
    for (const r of pending.values()) if (r.identity.sessionId === sessionId) merged.set(id(r), r);
    return [...merged.values()];
  },
  async retry(): Promise<void> { for (const r of [...pending.values()]) await this.save(r); },
  hasPending(): boolean { return pending.size > 0; }
};
export type MeetingHistoryClient = typeof meetingHistoryClient;
