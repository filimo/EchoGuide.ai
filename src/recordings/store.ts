import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { maxRecordingBytes, maxRecordingDurationMs, type Recording } from "./types";

export class RecordingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// Hash session IDs so no caller-controlled path is ever used on disk.
export class RecordingStore {
  private active = new Map<string, Recording>();
  constructor(readonly root = resolve(".echoguide/sessions/audio")) {}

  private directory(sessionId: string) {
    if (!sessionId || sessionId.length > 200) throw new RecordingError("Invalid session ID.");
    return join(this.root, createHash("sha256").update(sessionId).digest("hex"));
  }
  private metaPath(sessionId: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new RecordingError("Invalid recording ID.");
    return join(this.directory(sessionId), `${id}.json`);
  }
  private persist(record: Recording) {
    const path = this.metaPath(record.sessionId, record.id);
    writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  file(record: Recording) {
    this.metaPath(record.sessionId, record.id);
    return join(this.directory(record.sessionId), `${record.id}.${record.format}`);
  }
  get(sessionId: string, id: string): Recording {
    const path = this.metaPath(sessionId, id);
    if (!existsSync(path)) throw new RecordingError("Recording not found.", 404);
    const record = JSON.parse(readFileSync(path, "utf8")) as Recording;
    if (record.sessionId !== sessionId || record.id !== id || !["wav", "webm", "mp4"].includes(record.format)) {
      throw new RecordingError("Invalid recording metadata.", 500);
    }
    if (record.status === "recording" && !this.active.has(id)) {
      record.status = "interrupted";
      record.bytes = statSync(this.file(record)).size;
      if (record.format === "wav") {
        const audioBytes = Math.max(0, Math.floor((record.bytes - 44) / 4) * 4);
        const fd = openSync(this.file(record), "r+");
        try { writeSync(fd, wavHeader(audioBytes), 0, 44, 0); } finally { closeSync(fd); }
        record.durationMs = audioBytes / 96;
      }
      this.persist(record);
    }
    return record;
  }
  list(sessionId: string): Recording[] {
    const directory = this.directory(sessionId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
      .map(name => this.get(sessionId, name.slice(0, -5)))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  start(sessionId: string, format: Recording["format"]): Recording {
    if (this.isActive(sessionId)) throw new RecordingError("This session is already recording.", 409);
    if (!["wav", "webm", "mp4"].includes(format)) throw new RecordingError("Unsupported recording format.");
    const now = new Date().toISOString();
    const record: Recording = { id: randomUUID(), sessionId, format, startedAt: now, updatedAt: now,
      status: "recording", bytes: format === "wav" ? 44 : 0, durationMs: 0, sequence: 0 };
    mkdirSync(this.directory(sessionId), { recursive: true, mode: 0o700 });
    writeFileSync(this.file(record), format === "wav" ? wavHeader(0) : Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    this.persist(record);
    this.active.set(record.id, record);
    return { ...record };
  }
  append(sessionId: string, id: string, sequence: number, chunk: Buffer) {
    const record = this.active.get(id);
    if (!record || record.sessionId !== sessionId) throw new RecordingError("Recording has stopped.", 409);
    if (sequence !== record.sequence) throw new RecordingError("Recording chunk is out of order.", 409);
    if (record.bytes + chunk.length > maxRecordingBytes || Date.now() - Date.parse(record.startedAt) > maxRecordingDurationMs) {
      this.finish(sessionId, id, "interrupted");
      throw new RecordingError("Recording reached the 1 GB or 4 hour limit. Earlier audio is saved.", 413);
    }
    try {
      appendFileSync(this.file(record), chunk);
      record.bytes += chunk.length;
      record.sequence++;
      record.updatedAt = new Date().toISOString();
      record.durationMs = record.format === "wav"
        ? (record.bytes - 44) / 96 : Date.now() - Date.parse(record.startedAt);
      if (record.format === "wav") {
        // Checkpoint the header so even a process crash leaves the written PCM playable.
        const fd = openSync(this.file(record), "r+");
        try { writeSync(fd, wavHeader(record.bytes - 44), 0, 44, 0); } finally { closeSync(fd); }
      }
      this.persist(record);
      return { ...record };
    } catch {
      record.status = "error";
      this.active.delete(id);
      try { this.persist(record); } catch { /* Keep the last successful disk checkpoint. */ }
      throw new RecordingError("Audio could not be saved. Check local disk space.", 500);
    }
  }
  finish(sessionId: string, id: string, status: Recording["status"] = "saved") {
    const record = this.active.get(id);
    if (!record) return this.get(sessionId, id);
    if (record.sessionId !== sessionId) throw new RecordingError("Recording not found.", 404);
    record.status = status;
    record.updatedAt = new Date().toISOString();
    this.active.delete(id);
    this.persist(record);
    return { ...record };
  }
  isActive(sessionId: string) { return [...this.active.values()].some(record => record.sessionId === sessionId); }
  deleteSession(sessionId: string) {
    if (this.isActive(sessionId)) throw new RecordingError("Stop live before deleting this session.", 409);
    rmSync(this.directory(sessionId), { recursive: true, force: true });
  }
  expireBrowserRecordings() {
    for (const record of this.active.values()) {
      if (record.format !== "wav" && Date.now() - Date.parse(record.updatedAt) > 60_000) {
        this.finish(record.sessionId, record.id, "interrupted");
      }
    }
  }
}

export function wavHeader(bytes: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + bytes, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(bytes, 40);
  return header;
}

export const recordingStore = new RecordingStore();
