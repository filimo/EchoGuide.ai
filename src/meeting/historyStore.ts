import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMeetingCardSnapshot, type MeetingCardSnapshot } from "./history";

// Separate from operational diagnostics and from the replaceable session draft.
// Synchronous read/merge/rename prevents lost updates between middleware instances.
export class MeetingHistoryStore {
  constructor(private path = ".echoguide/sessions/meeting-cards.json") {}
  read(sessionId?: string): MeetingCardSnapshot[] {
    if (!existsSync(this.path)) return [];
    const data = JSON.parse(readFileSync(this.path, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.snapshots) || !data.snapshots.every(isMeetingCardSnapshot)) throw new Error("Invalid meeting history");
    return data.snapshots.filter((r: MeetingCardSnapshot) => !sessionId || r.identity.sessionId === sessionId);
  }
  save(value: unknown): void {
    if (!isMeetingCardSnapshot(value)) throw new Error("Invalid meeting card");
    const records = this.read();
    const attempt = records.filter(r => r.attemptId === value.attemptId);
    if (attempt.some(r => JSON.stringify(r.identity) !== JSON.stringify(value.identity))) throw new Error("Attempt identity changed");
    const existing = attempt.find(r => r.sequence === value.sequence);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error("Snapshot is immutable");
      return;
    }
    records.push(value);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ version: 1, snapshots: records }), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
