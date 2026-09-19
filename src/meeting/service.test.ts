import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingService } from "./service";
import { meetingFallback } from "./types";
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "meeting-test-")); directories.push(directory);
  let counter = 0;
  const files: Record<string, string[]> = {};
  const state = { batchFailed: false, responseStatus: "grounded", sourceIds: ["s1"], empty: false };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.openai.com/v1", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    let value: unknown = {};
    if (init?.method === "DELETE") value = { deleted: true };
    else if (path === "/vector_stores") value = { id: `vs_${++counter}` };
    else if (path === "/files") value = { id: `file_${++counter}` };
    else if (path.endsWith("/file_batches")) { files[path.split("/")[2]] = body.files.map((f: any) => f.file_id); value = { id: "batch" }; }
    else if (path.endsWith("/file_batches/batch")) value = { status: "completed", file_counts: { failed: state.batchFailed ? 1 : 0, completed: files[path.split("/")[2]].length } };
    else if (path.endsWith("/search")) value = { data: state.empty ? [] : files[path.split("/")[2]].map(file_id => ({ file_id })) };
    else if (path === "/responses") value = { output_text: JSON.stringify({ status: state.responseStatus, english: "The pilot is still a proposal. [s1]", russian: "Пилот пока предложен. [s1]", sourceIds: state.sourceIds }) };
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
  const service = new MeetingService({ directory, apiKey: () => "test-only", fetchImpl });
  const ready = async (name = "Pack") => {
    const snapshot = service.create(name, [{ name: "status.md", text: "# Status\nПилот пока не выбран." }]);
    const id = snapshot.packs[0].id;
    await vi.waitFor(() => expect(service.snapshot().packs.find(p => p.id === id)?.status).toBe("indexing"));
    await service.refresh(); return id;
  };
  return { service, state, ready, fetchImpl, directory };
}
describe("meeting pack lifecycle and grounding", () => {
  it("does not activate uploads and preserves active pack when indexing fails", async () => {
    const { service, ready, state } = setup();
    const old = await ready(); service.activate(old);
    state.batchFailed = true; const failed = await ready("New");
    expect(service.snapshot().activePackId).toBe(old);
    expect(() => service.activate(failed)).toThrow();
    expect(service.snapshot().packs[0].status).toBe("failed");
  });
  it("isolates search to the active store and validates evidence IDs", async () => {
    const { service, ready, fetchImpl, state } = setup(); const id = await ready(); service.activate(id);
    const found = await service.search(id, "Has the pilot started?", []);
    const result = await service.answer(id, found.ticket);
    expect(result.english).toBe("The pilot is still a proposal.");
    expect(result.russian).toBe("Пилот пока предложен.");
    expect(result.status).toBe("grounded"); expect(result.sources[0].filename).toBe("status.md");
    const call = vi.mocked(fetchImpl).mock.calls.find(c => String(c[0]).endsWith("/search"))!;
    expect(JSON.parse(call[1]!.body as string).filters.value).toBe(id);
    state.sourceIds = ["invented"];
    const invalid = await service.search(id, "question", []);
    expect(await service.answer(id, invalid.ticket)).toEqual(meetingFallback);
  });
  it("returns a safe fallback on no evidence without asking a model", async () => {
    const { service, ready, state, fetchImpl } = setup(); const id = await ready(); service.activate(id); state.empty = true;
    const found = await service.search(id, "Unknown detail", []);
    expect(await service.answer(id, found.ticket)).toEqual(meetingFallback);
    expect(vi.mocked(fetchImpl).mock.calls.some(c => String(c[0]).endsWith("/responses"))).toBe(false);
  });
  it("does not expose generated speculation when sources conflict", async () => {
    const { service, ready, state } = setup(); const id = await ready(); service.activate(id); state.responseStatus = "conflict";
    const found = await service.search(id, "question", []);
    expect(await service.answer(id, found.ticket)).toEqual({ ...meetingFallback, status: "conflict" });
  });
  it("rejects old tickets after switching packs and retains local archive", async () => {
    const { service, ready, directory } = setup(); const old = await ready(); service.activate(old);
    const found = await service.search(old, "question", []); const next = await ready("Next"); service.activate(next);
    await expect(service.answer(old, found.ticket)).rejects.toThrow();
    await expect(service.search(old, "question", [])).rejects.toThrow();
    const restored = new MeetingService({ directory, apiKey: () => "unused" });
    expect(restored.snapshot().activePackId).toBe(next); expect(restored.snapshot().packs).toHaveLength(2);
  });
  it("deletes only the selected pack cloud resources and clears its active selection", async () => {
    const { service, ready, fetchImpl } = setup(); const id = await ready(); service.activate(id); const other = await ready("Other");
    await service.remove(id);
    expect(service.snapshot().activePackId).toBeNull(); expect(service.snapshot().packs[0].id).toBe(other);
    expect(vi.mocked(fetchImpl).mock.calls.filter(c => c[1]?.method === "DELETE")).toHaveLength(2);
  });
});
