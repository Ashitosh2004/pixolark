/**
 * Rate-limit discipline for the shared pub/sub (ntfy.sh free tier:
 * ~60 requests / 5 min and ~250 messages / day per visitor IP).
 *
 * These tests pin the behaviors that keep rooms discoverable and joinable:
 * - the signaling poll is a slow fallback, never a 2.5s treadmill;
 * - 429s back off exponentially instead of hammering;
 * - publishes retry transient failures, but the room-closed tombstone is a
 *   single keepalive shot (it rides pagehide and must never be re-queued);
 * - SSE being open means zero HTTP polls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSignal, publishSignal, ROOM_CLOSED, subscribeSignal } from "@/lib/pixel/signaling";

const CODE = "PXC1.abcDEF123_-xyz";

const jsonRes = (lines: string[], status = 200) => new Response(lines.join("\n"), { status });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchSignal", () => {
  it("extracts the newest code, honors tombstones, and reports rate limiting", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(jsonRes([JSON.stringify({ message: ROOM_CLOSED }), JSON.stringify({ message: `newest ${CODE}` })]))
      .mockResolvedValueOnce(jsonRes([JSON.stringify({ message: CODE }), JSON.stringify({ message: ROOM_CLOSED })]))
      .mockResolvedValueOnce(new Response("limited", { status: 429 }));
    vi.stubGlobal("fetch", f);
    // Newest line (last) is the code → returned even over an older tombstone.
    expect(await fetchSignal("582914", "offer")).toEqual({ code: CODE, closed: false, limited: false });
    // Newest line is the tombstone → closed, regardless of older codes.
    expect(await fetchSignal("582914", "offer")).toEqual({ code: null, closed: true, limited: false });
    // Rate limited: nothing usable, but the caller learns it must back off.
    expect(await fetchSignal("582914", "offer")).toEqual({ code: null, closed: false, limited: true });
  });
});

describe("publishSignal", () => {
  it("retries transient failures with backoff and succeeds", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockRejectedValueOnce(new Error("network hiccup"))
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const p = publishSignal("582914", "offer", CODE);
    await vi.advanceTimersByTimeAsync(3_000); // retry 1 after 3s
    await vi.advanceTimersByTimeAsync(6_000); // retry 2 after 6s
    expect(await p).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("gives up after the requested retries on persistent failure", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", f);
    const p = publishSignal("582914", "answer", CODE, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await p).toBe(false);
    expect(f).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("the room-closed tombstone is a single keepalive shot, never retried", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", f);
    // Even with retries explicitly requested, the tombstone must not be re-queued:
    // it is published during pagehide, where timers never fire again.
    const p = publishSignal("582914", "offer", ROOM_CLOSED, 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![1]?.keepalive).toBe(true);
  });
});

describe("subscribeSignal", () => {
  let esPush: ((e: { data: string }) => void) | null = null;
  class FakeES {
    readyState = 1; // OPEN
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor() {
      esPush = (e) => this.onmessage?.(e);
    }
    close(): void {}
  }

  it("does not poll once the SSE stream has proven it flows", async () => {
    vi.useFakeTimers();
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("EventSource", FakeES);
    const stop = subscribeSignal("582914", "answer", () => {});
    // SSE delivers one event (any event — even a keepalive proves the stream flows)
    (esPush as unknown as (e: { data: string }) => void)({ data: JSON.stringify({ event: "open" }) });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f).not.toHaveBeenCalled(); // SSE delivers everything; zero poll requests
    stop();
  });

  it("keeps the slow poll alive while a hung SSE socket stays open-but-silent", async () => {
    // Regression: an SSE connection can sit readyState OPEN forever without
    // delivering a single event — the fallback poll must keep running.
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(jsonRes([JSON.stringify({ message: CODE })]));
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("EventSource", FakeES);
    const got: string[] = [];
    const stop = subscribeSignal("582914", "answer", (c) => got.push(c));
    await vi.advanceTimersByTimeAsync(3_000); // catch-up sweep delivers via poll
    expect(got).toEqual([CODE]);
    await vi.advanceTimersByTimeAsync(45_000); // no SSE event ever arrived → polls continue
    expect(f.mock.calls.length).toBeGreaterThan(2);
    stop();
  });

  it("falls back to a slow poll and backs off exponentially on 429", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", f); // no EventSource stub → poll-only path
    const stop = subscribeSignal("582914", "answer", () => {});
    await vi.advanceTimersByTimeAsync(3_000); // catch-up sweep → 429 → next in 30s
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000); // t=18s — still backing off
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000); // t=33s → 429 → next in 60s
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_000); // t=92s — not yet
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000); // t=94s → capped backoff 60s
    expect(f).toHaveBeenCalledTimes(3);
    stop();
  });

  it("delivers SSE payloads and the catch-up poll to the handler", async () => {
    vi.useFakeTimers();
    let push: ((e: { data: string }) => void) | null = null;
    class FakeES {
      readyState = 0; // CONNECTING at first
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        push = (e) => this.onmessage?.(e);
      }
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeES);
    const f = vi.fn().mockResolvedValue(jsonRes([JSON.stringify({ message: CODE })]));
    vi.stubGlobal("fetch", f);
    const got: string[] = [];
    const stop = subscribeSignal("582914", "answer", (c) => got.push(c));
    await vi.advanceTimersByTimeAsync(3_000); // catch-up sweep finds the code
    expect(got).toEqual([CODE]);
    // The constructor ran synchronously inside subscribeSignal, so the SSE hook is live.
    (push as unknown as (e: { data: string }) => void)({ data: JSON.stringify({ message: `live ${CODE}` }) });
    expect(got).toEqual([CODE, CODE]);
    stop();
  });
});
