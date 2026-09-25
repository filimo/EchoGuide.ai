// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { connectMacAudio, monitorMacMicrophone, routeStandbyMicrophone } from "./client";

describe("Mac audio streamed client", () => {
  it("starts idle microphone routing and stops it on request", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n'));
    } });
    const fetchImpl = vi.fn(async () => new Response(body));
    const route = routeStandbyMicrophone("usb", onReady, onError, fetchImpl);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(fetchImpl).toHaveBeenCalledWith("/api/mac-audio/standby",
      expect.objectContaining({ body: JSON.stringify({ microphone: "usb" }) }));
    route.stop();
    expect(onError).not.toHaveBeenCalled();
  });
  it("waits for the live session to release Mac audio before restoring BlackHole", async () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n'));
    } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Mac audio is already running." }), { status: 409 }))
      .mockResolvedValueOnce(new Response(body));
    const route = routeStandbyMicrophone("usb", onReady, onError, fetchImpl);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    route.stop();
  });
  it("reads microphone monitor levels and stops without sending audio", async () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"ready"}\n{"type":"level","level":0.01,"peak":0.1}\n'));
    } });
    const fetchImpl = vi.fn(async () => new Response(body));
    const monitor = monitorMacMicrophone("usb", onEvent, onError, fetchImpl);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));
    expect(fetchImpl).toHaveBeenCalledWith("/api/mac-audio/microphone-monitor",
      expect.objectContaining({ body: JSON.stringify({ microphone: "usb" }) }));
    expect(onEvent).toHaveBeenLastCalledWith({ type: "level", level: 0.01, peak: 0.1 });
    monitor.stop();
    expect(onError).not.toHaveBeenCalled();
  });
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
