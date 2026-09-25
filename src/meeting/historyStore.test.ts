// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingHistoryStore } from "./historyStore";
import { latestMeetingCard, meetingCardKey, type MeetingCardSnapshot } from "./history";
import { meetingFallbackFor } from "./types";
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "meeting-history-")); directories.push(directory);
  const path = join(directory, "meeting-cards.json"); return { path, store: new MeetingHistoryStore(path) };
}
const snapshot: MeetingCardSnapshot = { version: 1, attemptId: "attempt-1", sequence: 1, savedAt: "2026-09-20T10:00:00Z",
  identity: { sessionId: "s1", phraseId: "p1", packId: "pack1", text: "Question?", speaker: "Heard", context: [] },
  packName: "Synthetic", packCreatedAt: "2026-09-20", opening: { mode: "start", english: "Let me explain.", russian: "Поясню." },
  answer: null, phase: "opening", progress: "Loading", timings: { openingMs: 123 } };
describe("permanent meeting card snapshots", () => {
  it("round-trips exact bilingual stages, sources and prior attempts across instances", () => {
    const { path, store } = setup(); expect(store.read()).toEqual([]);
    store.save(snapshot);
    const completed: MeetingCardSnapshot = { ...snapshot, sequence: 2, phase: "complete", answer: { status: "grounded", english: "A proposal.", russian: "Предложение.",
      sources: [{ id: "x", filename: "source.md", heading: "Status", text: "Synthetic evidence.", metadata: { source_hash: "hash" } }] } };
    new MeetingHistoryStore(path).save(completed);
    store.save({ ...snapshot, attemptId: "attempt-2" });
    expect(new MeetingHistoryStore(path).read("s1")).toEqual([snapshot, completed, { ...snapshot, attemptId: "attempt-2" }]);
    expect(store.read("another-session")).toEqual([]);
  });
  it("persists a fallback reason in the archive and accepts legacy answers without diagnostics", () => {
    const { store } = setup();
    const diagnosed = { ...snapshot, phase: "complete" as const, answer: meetingFallbackFor("model_no_answer", 2) };
    store.save(diagnosed);
    store.save({ ...snapshot, attemptId: "legacy", phase: "complete", answer: { ...meetingFallbackFor("no_hits", 0), diagnostics: undefined } });
    expect(store.read()[0].answer?.diagnostics).toEqual({ reason: "model_no_answer", found: 2 });
    expect(store.read()[1].answer?.diagnostics).toBeUndefined();
  });
  it("retains out-of-order earlier stages without replacing later snapshots; retries are idempotent", () => {
    const { store } = setup(); store.save({ ...snapshot, sequence: 2 }); store.save(snapshot); store.save(snapshot);
    expect(store.read()).toHaveLength(2);
    expect(() => store.save({ ...snapshot, progress: "changed" })).toThrow("immutable");
    expect(() => store.save({ ...snapshot, sequence: 3, identity: { ...snapshot.identity, sessionId: "other" } })).toThrow("identity");
    expect(() => store.save({ ...snapshot, sequence: 3, identity: { ...snapshot.identity, context: ["changed"] } })).toThrow("identity");
  });
  it("keeps phrase identity stable as context and summary evolve", () => {
    for (const identity of [{ ...snapshot.identity, sessionId: "s2" }, { ...snapshot.identity, phraseId: "p2" },
      { ...snapshot.identity, text: "Edited?" }, { ...snapshot.identity, speaker: "Me" },
      { ...snapshot.identity, packId: "pack2" }]) {
      expect(meetingCardKey(identity)).not.toBe(meetingCardKey(snapshot.identity));
    }
    expect(meetingCardKey({ ...snapshot.identity, context: ["new"], summary: "Later summary" })).toBe(meetingCardKey(snapshot.identity));
  });
  it("fails closed on corrupt archives without overwriting them", () => {
    const { store, path } = setup(); writeFileSync(path, "broken");
    expect(() => store.read()).toThrow(); expect(() => store.save(snapshot)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("broken");
  });
  it("rejects invalid or oversized snapshots without writing", () => {
    const { store } = setup();
    for (const value of [{}, { ...snapshot, opening: { english: "only English" } },
      { ...snapshot, identity: { ...snapshot.identity, text: "x".repeat(4001) } }, { ...snapshot, sequence: -1 },
      { ...snapshot, answer: { ...meetingFallbackFor("no_hits", 0), diagnostics: { reason: "unknown" } } }]) expect(() => store.save(value)).toThrow();
    expect(store.read()).toEqual([]);
  });
});

it("restores the latest attempt even when older snapshots are retried later", () => {
  const newer = { ...snapshot, attemptId: "new", savedAt: "2026-09-20T10:01:00Z" };
  const oldCompletion = { ...snapshot, sequence: 2, savedAt: "2026-09-20T10:02:00Z" };
  expect(latestMeetingCard([newer, oldCompletion, snapshot])).toEqual(newer);
});
