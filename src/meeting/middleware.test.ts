import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMeetingMiddleware } from "./middleware";
import type { MeetingService } from "./service";

async function request(path: string, body: unknown, origin = "https://localhost:5173", http2 = false) {
  const api = { search: vi.fn(), answer: vi.fn(), general: vi.fn(), refresh: vi.fn() };
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: `/api/meeting/${path}`, method: "POST", headers: { ...(http2 ? { ":authority": "localhost:5173" } : { host: "localhost:5173" }), origin }
  });
  const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
  await createMeetingMiddleware(api as unknown as MeetingService)(req as IncomingMessage, res as unknown as ServerResponse, vi.fn());
  return { api, res };
}
describe("meeting API boundary", () => {
  it("rejects cross-origin upload or search", async () => {
    const { api, res } = await request("search", {}, "https://unrelated.example");
    expect(res.statusCode).toBe(403); expect(api.search).not.toHaveBeenCalled();
  });
  it("rejects unbounded conversation before calling OpenAI", async () => {
    const { api, res } = await request("search", { packId: "p", transcript: "q", recentContext: ["x".repeat(2001)] });
    expect(res.statusCode).toBe(400); expect(api.search).not.toHaveBeenCalled();
  });
  it("validates the independent general-answer request", async () => {
    const invalid = await request("general", { transcript: "Question?", recentContext: [], speakerLabel: "x".repeat(101) });
    expect(invalid.res.statusCode).toBe(400); expect(invalid.api.general).not.toHaveBeenCalled();
    const valid = await request("general", { transcript: "Question?", recentContext: [], speakerLabel: "Interviewer" });
    expect(valid.res.statusCode).toBe(200);
    expect(valid.api.general).toHaveBeenCalledWith("Question?", [], "Interviewer", undefined);
  });
  it("does not accept client evidence instead of a server search ticket", async () => {
    const { api, res } = await request("answer", { packId: "p", evidence: ["fake"] });
    expect(res.statusCode).toBe(404); expect(api.answer).not.toHaveBeenCalled();
  });
});

it("accepts same-origin HTTP/2 requests using :authority", async () => {
  const { api, res } = await request("search", { packId: "p", transcript: "Question?", recentContext: [] }, "https://localhost:5173", true);
  expect(res.statusCode).toBe(200);
  expect(api.search).toHaveBeenCalledWith("p", "Question?", []);
});
it("still rejects foreign origins on HTTP/2", async () => {
  const { api, res } = await request("search", {}, "https://unrelated.example", true);
  expect(res.statusCode).toBe(403); expect(api.search).not.toHaveBeenCalled();
});
