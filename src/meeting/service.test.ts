import { englishRealtimeTranscriptionPrompt } from "../realtime/realtimeSession";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingService } from "./service";
import { meetingFallbackFor } from "./types";
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function setup(reasoningEffort?: () => string) {
  const directory = mkdtempSync(join(tmpdir(), "meeting-test-")); directories.push(directory);
  let counter = 0;
  const files: Record<string, string[]> = {};
  const state = { batchFailed: false, responseStatus: "grounded", sourceIds: ["s1"], empty: false, english: "The pilot is still a proposal. [s1]", russian: "Пилот пока предложен. [s1]" };
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
    else if (path === "/responses") value = body.text?.format?.name === "meeting_conversation_summary"
      ? { output_text: JSON.stringify({ summary: "Собеседник предложил проверить процесс; решение не принято." }) }
      : { output_text: JSON.stringify({ status: state.responseStatus, english: state.english, russian: state.russian, sourceIds: state.sourceIds }) };
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
  const service = new MeetingService({ directory, apiKey: () => "test-only", reasoningEffort, fetchImpl });
  const ready = async (name = "Pack", text = "# Status\nПилот пока не выбран.") => {
    const snapshot = service.create(name, [{ name: "status.md", text }]);
    const id = snapshot.packs[0].id;
    await vi.waitFor(() => expect(service.snapshot().packs.find(p => p.id === id)?.status).toBe("indexing"));
    await service.refresh(); return id;
  };
  return { service, state, ready, fetchImpl, directory };
}
describe("meeting pack lifecycle and grounding", () => {
  it("summarizes older dialogue separately and treats it as conversational context", async () => {
    const { service, fetchImpl, ready } = setup();
    const summary = await service.summarize("", ["Interviewer: Could we try it?", "Me: I would test one task."]);
    expect(summary).toContain("решение не принято");
    const summaryCall = vi.mocked(fetchImpl).mock.calls.find(call =>
      JSON.parse(String(call[1]?.body ?? "{}")).text?.format?.name === "meeting_conversation_summary")!;
    expect(JSON.parse(summaryCall[1]!.body as string).store).toBe(false);
    const id = await ready(); service.activate(id);
    const found = await service.search(id, "What did we decide?", ["Me: We need a pilot."], summary);
    await service.answer(id, found.ticket);
    const answerCall = vi.mocked(fetchImpl).mock.calls.filter(call => String(call[0]).endsWith("/responses")).at(-1)!;
    expect(JSON.parse(JSON.parse(answerCall[1]!.body as string).input).conversationSummary).toBe(summary);
  });
  it("keeps the live reasoning effort at none and allows an eval override", async () => {
    let effort = "low";
    const { service, ready, fetchImpl } = setup(() => effort);
    const id = await ready(); service.activate(id);
    let found = await service.search(id, "What is the pilot status?", []);
    await service.answer(id, found.ticket);
    effort = "medium";
    found = await service.search(id, "What is the pilot status?", []);
    await service.answer(id, found.ticket);
    const requests = vi.mocked(fetchImpl).mock.calls
      .filter(call => String(call[0]).endsWith("/responses"))
      .map(call => JSON.parse(call[1]!.body as string));
    expect(requests.map(request => request.reasoning.effort)).toEqual(["low", "medium"]);
    const defaultSession = setup();
    const defaultId = await defaultSession.ready(); defaultSession.service.activate(defaultId);
    found = await defaultSession.service.search(defaultId, "What is the pilot status?", []);
    await defaultSession.service.answer(defaultId, found.ticket);
    const defaultRequest = vi.mocked(defaultSession.fetchImpl).mock.calls
      .find(call => String(call[0]).endsWith("/responses"))!;
    expect(JSON.parse(defaultRequest[1]!.body as string).reasoning.effort).toBe("none");
  });
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
    expect(await service.answer(id, invalid.ticket)).toEqual(meetingFallbackFor("invalid_answer", 1));
  });
  it("removes a repeated bilingual opening while retaining grounded sources", async () => {
    const { service, ready, state } = setup(); const id = await ready(); service.activate(id);
    const opening = { mode: "start" as const, english: "The pilot is still a proposal.", russian: "Этот пилот пока только предложен." };
    state.english = `${opening.english} We need to agree on scope. [s1]`;
    state.russian = `${opening.russian} Нужно согласовать объём. [s1]`;
    const found = await service.search(id, "What is next?", []);
    const answer = await service.answer(id, found.ticket, opening);
    expect(answer.english).toBe("We need to agree on scope.");
    expect(answer.russian).toBe("Нужно согласовать объём.");
    expect(answer.sources[0].filename).toBe("status.md");
    expect(answer.status).toBe("grounded");
  });
  it("repairs both languages once when the repeated translation is paraphrased", async () => {
    const { service, ready, state, fetchImpl } = setup(); const id = await ready(); service.activate(id);
    const opening = { mode: "start" as const, english: "The pilot is still a proposal.", russian: "Этот пилот пока только предложен." };
    state.english = `${opening.english} We need to agree on scope.`;
    state.russian = "Пока это лишь предложение пилота. Нужно согласовать объём.";
    const found = await service.search(id, "What is next?", []);
    const original = vi.mocked(fetchImpl).getMockImplementation()!;
    vi.mocked(fetchImpl).mockImplementation(async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (body.instructions?.includes("CORRECTION:")) return new Response(JSON.stringify({ output_text: JSON.stringify({
        status: "grounded", english: "We need to agree on scope.", russian: "Нужно согласовать объём.", sourceIds: ["s1"]
      }) }));
      return original(url, init);
    });
    const answer = await service.answer(id, found.ticket, opening);
    expect(answer.english).toBe("We need to agree on scope.");
    expect(answer.russian).toBe("Нужно согласовать объём.");
    expect(vi.mocked(fetchImpl).mock.calls.filter(c => String(c[0]).endsWith("/responses"))).toHaveLength(2);
  });
  it("keeps the original question and makes product interpretation conditional in both languages", async () => {
    const { service, ready, fetchImpl } = setup();
    const id = await ready("Sample", "# Status\nMaria tried Codex. The pilot is still a proposal."); service.activate(id);
    const question = "What has Maria confirmed about codecs usage?";
    const found = await service.search(id, question, []);
    const answer = await service.answer(id, found.ticket);
    expect(answer.english).toMatch(/^If you mean Codex:/);
    expect(answer.russian).toMatch(/^Если ты имеешь в виду Codex:/);
    const call = vi.mocked(fetchImpl).mock.calls.find(c => String(c[0]).endsWith("/responses"))!;
    const input = JSON.parse(JSON.parse(call[1]!.body as string).input);
    expect(input.originalTranscript).toBe(question);
    expect(input.transcript).toBe("What has Maria confirmed about Codex usage?");
    expect(input.interpretation).toContain("Unconfirmed");
  });
  it("does not turn an unsupported interpreted answer into a grounded answer", async () => {
    const { service, ready, state } = setup();
    const id = await ready("Sample", "# Status\nMaria tried Codex."); service.activate(id);
    state.responseStatus = "no_answer";
    const found = await service.search(id, "What has an unknown person confirmed about codecs usage?", []);
    expect(await service.answer(id, found.ticket)).toEqual(meetingFallbackFor("model_no_answer", 1));
  });
  it("returns a safe fallback on no evidence without asking a model", async () => {
    const { service, ready, state, fetchImpl } = setup(); const id = await ready(); service.activate(id); state.empty = true;
    const found = await service.search(id, "Unknown detail", []);
    expect(await service.answer(id, found.ticket)).toEqual(meetingFallbackFor("no_hits", 0));
    expect(vi.mocked(fetchImpl).mock.calls.some(c => String(c[0]).endsWith("/responses"))).toBe(false);
  });
  it("does not expose generated speculation when sources conflict", async () => {
    const { service, ready, state } = setup(); const id = await ready(); service.activate(id); state.responseStatus = "conflict";
    const found = await service.search(id, "question", []);
    expect(await service.answer(id, found.ticket)).toEqual(meetingFallbackFor("conflict", 1));
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

it("uses the focused question and clean dialogue in retrieval and continuation", async () => {
  const { service, ready, fetchImpl } = setup(); const id = await ready(); service.activate(id);
  const found = await service.search(id, "Old feedback. Next question: How do we measure total effort?", [`Me: ${englishRealtimeTranscriptionPrompt}`, "Me: Include review time."]);
  await service.answer(id, found.ticket);
  const calls = vi.mocked(fetchImpl).mock.calls;
  const query = JSON.parse(calls.find(c => String(c[0]).endsWith("/search"))![1]!.body as string).query;
  expect(query).toContain("How do we measure total effort?");
  expect(query).not.toContain("Old feedback");
  expect(query).not.toContain(englishRealtimeTranscriptionPrompt);
  const request = JSON.parse(calls.find(c => String(c[0]).endsWith("/responses"))![1]!.body as string);
  expect(JSON.parse(request.input).transcript).toBe("How do we measure total effort?");
  expect(JSON.parse(request.input).recentContext).toEqual(["Me: Include review time."]);
  await expect(service.search(id, englishRealtimeTranscriptionPrompt, [])).rejects.toThrow("No spoken input");
});
