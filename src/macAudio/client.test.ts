// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { connectMacAudio } from "./client";

describe("Mac audio streamed client", () => {
  it("handles split NDJSON and UTF-8 chunks and stops reading on disconnect", async () => {
    let writer: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    const onEvent = vi.fn();
    const encoder = new TextEncoder();
    const promise = connectMacAudio({ pid: 1, microphone: "default", language: "russian",
      signal: new AbortController().signal, onEvent, onError: vi.fn(),
      fetchImpl: vi.fn(async () => new Response(stream)) });
    const bytes = encoder.encode('{"type":"ready"}\n{"type":"error","message":"Ошибка"}\n');
    writer!.enqueue(bytes.slice(0, 8));
    writer!.enqueue(bytes.slice(8, 50));
    writer!.enqueue(bytes.slice(50));
    const connection = await promise;
    expect(onEvent).toHaveBeenCalledWith({ type: "ready" });
    connection.disconnect();
  });
  it("rejects a startup error and cancels the response reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"error","message":"Permission denied"}\n'));
    }, cancel });
    await expect(connectMacAudio({ pid: 1, microphone: "default", language: "english",
      signal: new AbortController().signal, onEvent: vi.fn(), onError: vi.fn(),
      fetchImpl: vi.fn(async () => new Response(body)) })).rejects.toThrow("Permission denied");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
