import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportBackup, importBackup, loadBookmarks, loadDraft, loadGroupSnapshot, loadRecentRooms,
  saveBookmark, saveDraft, saveGroupSnapshot, setRoomMuted, isRoomMuted, pushRecentRoom, removeBookmark,
} from "@/lib/pixel/storage";
import { deliver, dndActive, mentionsMe, recentNotifications, setDndUntil } from "@/lib/pixel/notifications";

beforeEach(() => {
  localStorage.clear();
  setDndUntil(0);
});

describe("local storage layer", () => {
  it("drafts round-trip and clear on empty text", () => {
    saveDraft("PXROOM-1", "hello draft");
    expect(loadDraft("PXROOM-1")).toBe("hello draft");
    saveDraft("PXROOM-1", "");
    expect(loadDraft("PXROOM-1")).toBe("");
  });

  it("bookmarks dedupe per room and mute state is queryable", () => {
    saveBookmark({ room: "PXROOM-1", kind: "group", name: "A", at: 0 });
    saveBookmark({ room: "PXROOM-1", kind: "group", name: "A2", at: 0 });
    saveBookmark({ room: "PXROOM-2", kind: "peer", name: "B", at: 0 });
    expect(loadBookmarks().map((b) => b.room).sort()).toEqual(["PXROOM-1", "PXROOM-2"]);
    expect(loadBookmarks().find((b) => b.room === "PXROOM-1")?.name).toBe("A2");
    expect(isRoomMuted("PXROOM-2")).toBe(false);
    setRoomMuted("PXROOM-2", "peer", "B", true);
    expect(isRoomMuted("PXROOM-2")).toBe(true);
    setRoomMuted("PXROOM-2", "peer", "B", false);
    expect(isRoomMuted("PXROOM-2")).toBe(false);
    removeBookmark("PXROOM-1");
    expect(loadBookmarks().map((b) => b.room)).toEqual(["PXROOM-2"]);
  });

  it("recents keep the newest first and cap the list", () => {
    for (let i = 0; i < 15; i++) pushRecentRoom(`PXROOM-${i}`, "group", `R${i}`, "host");
    const list = loadRecentRooms();
    expect(list.length).toBe(12);
    expect(list[0]!.room).toBe("PXROOM-14");
    expect(list[0]!.role).toBe("host");
  });

  it("host snapshots round-trip verbatim", () => {
    const snap = { meta: { room: "PXROOM-9", name: "Recover me" }, roster: [{ id: "x", role: "owner" }], epoch: 3 };
    saveGroupSnapshot("PXROOM-9", snap);
    const loaded = loadGroupSnapshot("PXROOM-9");
    expect(loaded?.snap).toEqual(snap);
    expect(loaded?.savedAt).toBeGreaterThan(0);
    expect(loadGroupSnapshot("PXROOM-404")).toBeNull();
  });

  it("backup round-trips entries and rejects wrong passphrases", async () => {
    localStorage.setItem("pxc.prefs.v1", JSON.stringify({ username: "alice" }));
    saveDraft("PXROOM-1", "secret draft");
    saveBookmark({ room: "PXROOM-1", kind: "group", name: "G", at: 0 });

    const json = await exportBackup("correct horse");
    const file = JSON.parse(json);
    expect(file.v).toBe(1);
    expect(file.kdf).toBe("PBKDF2-SHA256");

    localStorage.clear();
    const n = await importBackup(json, "correct horse");
    expect(n).toBeGreaterThanOrEqual(3);
    expect(loadDraft("PXROOM-1")).toBe("secret draft");
    expect(JSON.parse(localStorage.getItem("pxc.prefs.v1")!).username).toBe("alice");

    // Never imports with the wrong passphrase; nothing is written.
    localStorage.clear();
    await expect(importBackup(json, "wrong")).rejects.toThrow(/passphrase|corrupt/i);
    expect(localStorage.getItem("pxc.draft.PXROOM-1")).toBeNull();

    await expect(importBackup("{ not a backup", "x")).rejects.toThrow(/not a Pixolark backup/);
  });

  it("a tampered backup ciphertext is rejected (AES-GCM integrity)", async () => {
    const json = await exportBackup("pw");
    const file = JSON.parse(json);
    file.ct = file.ct.slice(0, -2) + (file.ct.endsWith("A") ? "BB" : "AA");
    await expect(importBackup(JSON.stringify(file), "pw")).rejects.toThrow();
  });
});

describe("notification router", () => {
  const opts = (over: Partial<Parameters<typeof deliver>[1]> = {}) => ({
    muted: false, sounds: false, notifications: true, myName: "alice", ...over,
  });

  it("detects @mentions with word boundaries and unicode names", () => {
    expect(mentionsMe("hey @alice come here", "alice")).toBe(true);
    expect(mentionsMe("@Alice!", "alice")).toBe(true);
    expect(mentionsMe("email me at alice@x.com", "alice")).toBe(false); // no @ prefix
    expect(mentionsMe("notalicia", "alice")).toBe(false);
    expect(mentionsMe("ನೋಡು @ಗೆಳೆಯ", "ಗೆಳೆಯ")).toBe(true);
    expect(mentionsMe(undefined, "alice")).toBe(false);
  });

  it("DND silences everything until it expires", () => {
    setDndUntil(Date.now() + 60_000);
    expect(dndActive()).toBe(true);
    const r = deliver({ room: "PXROOM-1", roomName: "G", senderName: "bob", body: "hi", mention: true }, opts());
    expect(r).toEqual({ out: "none", reason: "dnd" });
    expect(recentNotifications().length).toBe(0);
  });

  it("global and per-room mutes suppress sound and notifications", () => {
    const r1 = deliver({ room: "PXROOM-1", roomName: "G", senderName: "bob", body: "hi" }, opts({ muted: true }));
    expect(r1.reason).toBe("muted");
    setRoomMuted("PXROOM-1", "group", "G", true);
    const r2 = deliver({ room: "PXROOM-1", roomName: "G", senderName: "bob", body: "hi" }, opts());
    expect(r2.reason).toBe("muted");
  });

  it("normal messages notify only when the tab is hidden; mentions always", () => {
    class FakeNotification {
      static permission = "granted";
      constructor(public title: string, public body: { body: string; tag: string }) {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    try {
      // jsdom reports the document as visible: no notification for a normal message.
      const r1 = deliver({ room: "PXROOM-1", roomName: "G", senderName: "bob", body: "hi" }, opts());
      expect(r1.out).toBe("none");

      const r2 = deliver({ room: "PXROOM-1", roomName: "G", senderName: "bob", body: "hi", text: "ping @alice" }, opts());
      expect(r2.out).toBe("notify");
      expect(recentNotifications()[0]).toMatchObject({ mention: true, notified: true, senderName: "bob" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips the notification constructor when the user opted out or permission is missing", () => {
    class FakeNotification {
      static permission = "granted";
      constructor() { throw new Error("should not be constructed"); }
    }
    vi.stubGlobal("Notification", FakeNotification);
    try {
      const r = deliver({ room: "PXROOM-1", roomName: "G", senderName: "bob", body: "hi", text: "@alice" }, opts({ notifications: false }));
      expect(r.out).toBe("none");

      (FakeNotification as unknown as { permission: string }).permission = "denied";
      const r2 = deliver({ room: "PXROOM-1", roomName: "G", senderName: "bob", body: "hi", text: "@alice" }, opts());
      expect(r2.out).toBe("none");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
