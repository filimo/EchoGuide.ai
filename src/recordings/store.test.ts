// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingStore } from "./store";
import { mixStereo } from "../macAudio/server";

const directories: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "echoguide-recording-test-")); directories.push(root);
  return new RecordingStore(root);
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("local audio storage", () => {
  it("mixes both voices into both channels and checkpoints a playable stereo WAV", () => {
    const store = setup(); const record = store.start("session-one", "wav");
    const mic = Buffer.alloc(4); mic.writeInt16LE(1000, 0); mic.writeInt16LE(32000, 2);
    const app = Buffer.alloc(4); app.writeInt16LE(-500, 0); app.writeInt16LE(32000, 2);
    const mixed = mixStereo(mic, app);
    expect([...Array(4)].map((_, i) => mixed.readInt16LE(i * 2))).toEqual([500, 500, 32767, 32767]);
    store.append(record.sessionId, record.id, 0, mixed);
    const file = readFileSync(store.file(record));
    expect(file.toString("ascii", 0, 4)).toBe("RIFF");
    expect(file.readUInt16LE(22)).toBe(2);
    expect(file.readUInt32LE(40)).toBe(8);
    expect(file.subarray(44)).toEqual(mixed);
    expect(store.finish(record.sessionId, record.id).status).toBe("saved");
    expect(new RecordingStore(store.root).list("session-one")[0].status).toBe("saved");
  });
  it("preserves incomplete audio after a process restart and removes it with its session", () => {
    const store = setup(); const record = store.start("../../outside", "webm");
    store.append(record.sessionId, record.id, 0, Buffer.from("synthetic chunk"));
    expect(() => store.deleteSession(record.sessionId)).toThrow("Stop live");
    const restarted = new RecordingStore(store.root);
    expect(restarted.list(record.sessionId)[0]).toMatchObject({ status: "interrupted", bytes: 15 });
    restarted.deleteSession(record.sessionId);
    expect(existsSync(store.file(record))).toBe(false);
    expect(restarted.list(record.sessionId)).toEqual([]);
  });
  it("rejects wrong sessions, reordered chunks, duplicate writers and traversal IDs", () => {
    const store = setup(); const record = store.start("one", "webm");
    expect(() => store.start("one", "wav")).toThrow("already recording");
    expect(() => store.append("other", record.id, 0, Buffer.alloc(3))).toThrow();
    expect(() => store.append("one", record.id, 1, Buffer.alloc(3))).toThrow("out of order");
    expect(() => store.get("one", "../../file")).toThrow("Invalid recording ID");
    store.append("one", record.id, 0, Buffer.alloc(3));
    expect(() => store.append("one", record.id, 0, Buffer.alloc(3))).toThrow("out of order");
    expect(store.get("one", record.id).bytes).toBe(3);
  });
  it("ends abandoned browser uploads and enforces the duration limit without losing earlier audio", () => {
    const store = setup(); const record = store.start("one", "mp4");
    store.append("one", record.id, 0, Buffer.from("audio"));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    store.expireBrowserRecordings();
    expect(store.get("one", record.id).status).toBe("interrupted");
    vi.restoreAllMocks();
    const wav = store.start("two", "wav");
    store.append("two", wav.id, 0, Buffer.alloc(8));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4 * 60 * 60 * 1000 + 1);
    expect(() => store.append("two", wav.id, 1, Buffer.alloc(8))).toThrow("limit");
    expect(store.get("two", wav.id)).toMatchObject({ bytes: 52, status: "interrupted" });
  });
});
