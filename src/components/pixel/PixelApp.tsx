import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { generateRoomId, normalizeRoomId } from "@/lib/pixel/codec";
import { PeerSession, type SessionState } from "@/lib/pixel/session";
import { GroupSession, type GroupMeta } from "@/lib/pixel/group";
import { play, setSoundEnabled } from "@/lib/pixel/sound";
import { fetchSignal, publishSignal, ROOM_CLOSED, subscribeSignal } from "@/lib/pixel/signaling";
import { CoordinatorClient, type CoordinatorState } from "@/lib/pixel/coordinator";
import { CoordinatorMemberLink, CoordinatorReception } from "@/lib/pixel/coordinator-room";
import {
  ensureUserIdentity,
  registerCommunityRoom,
  reownCommunityRoom,
  saveUserName,
  verifyOfferAgainstManifest,
  type UserIdentity,
} from "@/lib/pixel/community";
import { loadRecovery, saveRecovery } from "@/lib/pixel/recovery";
import type { RoomManifest } from "@/lib/pixel/manifest";
import {
  clearAllLocalData, clearHistory, clearLastRoom, loadGroupSnapshot, loadHistory, loadLastRoom, loadPrefs,
  purgeOldHistory, pushRecentRoom, saveBookmark, saveHistory, saveLastRoom, savePrefs, defaultPrefs,
  type LastRoom, type Prefs,
} from "@/lib/pixel/storage";
import { CallOverlay } from "./CallOverlay";
import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";
import { GroupCreate } from "./GroupCreate";
import { GuestJoin, HostWait } from "./Handshake";
import { Hub, type HubTab } from "./Hub";
import { SettingsPanel } from "./Settings";
import { useChat } from "./useChat";
import { useGroup } from "./useGroup";
import { PixelBackground } from "./ui";

type Stage = "hub" | "host" | "join" | "chat" | "group" | "group-create";

/** Group snapshot → community manifest metadata (public rooms only). */
function communityMetaOf(g: GroupSession) {
  const m = g.snap.meta;
  return {
    name: m.name,
    desc: m.desc,
    type: "public" as const,
    category: m.cat,
    region: m.region || "",
    subRegion: m.subRegion || "",
    city: m.city || "",
    languages: m.lang ? [m.lang] : ["English"],
  };
}

export default function PixelApp({
  mode,
  initialCode,
  initialRoom,
}: {
  mode?: "create" | "join" | undefined;
  initialCode?: string | undefined;
  initialRoom?: string | undefined;
}) {
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs());
  const [stage, setStage] = useState<Stage>("hub");
  const [hubTab, setHubTab] = useState<HubTab>("chats");
  const [session, setSession] = useState<PeerSession | null>(null);
  const [sessState, setSessState] = useState<SessionState>("preparing");
  const [roomId, setRoomId] = useState(initialRoom ?? "");
  const [group, setGroup] = useState<GroupSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [joiningRoom, setJoiningRoom] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ open: boolean; tab?: "security" | "profile" | undefined }>({ open: false });
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [verified, setVerified] = useState(false);
  const [lastRoom, setLastRoom] = useState<LastRoom | null>(() => loadLastRoom());
  const [retryTick, setRetryTick] = useState(0);
  const [groupRetry, setGroupRetry] = useState(0);
  const autoRan = useRef(false);
  const leavingRef = useRef(false); // set while the page/room is intentionally going away — blocks auto-rehost
  const rehostingRef = useRef(false);
  const regroupingRef = useRef(false);
  const stageRef = useRef<Stage>("hub");
  const lastNamedRef = useRef<string | null>(null);

  // ---------- coordinator (community rooms) ----------
  // One app-level connection. The coordinator relays ONLY signed manifests,
  // presence and WebRTC SDP — chat content stays on E2EE DataChannels.
  const coordRef = useRef<CoordinatorClient | null>(null);
  const [coordState, setCoordState] = useState<CoordinatorState>({ s: "idle" });
  const [coordHint, setCoordHint] = useState<string | null>(null);
  const receptionRef = useRef<CoordinatorReception | null>(null);
  const memberLinkRef = useRef<CoordinatorMemberLink | null>(null);
  const activeCommunityRoom = useRef<string | null>(null);
  const userRef = useRef<UserIdentity | null>(null);

  const COORDINATOR_URL = (import.meta.env["VITE_COORDINATOR_URL"] as string | undefined) ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/coordinator`;

  /** Lazily create + connect the coordinator client (idempotent). */
  const coordinator = useCallback((): CoordinatorClient => {
    if (coordRef.current) return coordRef.current;
    const client = new CoordinatorClient({
      url: COORDINATOR_URL,
      name: prefs.username,
      onState: (s) => setCoordState(s),
      onRoomOffline: (roomId) => {
        if (activeCommunityRoom.current === roomId) setCoordHint("This room went offline — its host's lease ended. Waiting for the host to return…");
      },
      onError: (code, message) => {
        if (code === "room-unavailable" || code === "proof-invalid") setCoordHint(message);
      },
    });
    client.setRtcHandler((roomId, from, data) => {
      // Route relayed signaling to whichever side we currently are.
      if (receptionRef.current && activeCommunityRoom.current === roomId) void receptionRef.current.handleRtc(from, data);
      if (memberLinkRef.current && activeCommunityRoom.current === roomId) memberLinkRef.current.handleRtc(from, data);
    });
    coordRef.current = client;
    client.connect();
    return client;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [COORDINATOR_URL]);

  const dropCoordinatorSides = useCallback(() => {
    receptionRef.current?.stop();
    receptionRef.current = null;
    memberLinkRef.current?.stop();
    memberLinkRef.current = null;
    activeCommunityRoom.current = null;
  }, []);

  const setPrefs = useCallback((fn: (p: Prefs) => Prefs) => setPrefsState((p) => { const n = fn(p); savePrefs(n); return n; }), []);
  const api = useChat(session, prefs, { muted, blocked, initial: [] });
  const groupApi = useGroup(group, { prefs, muted, history: prefs.saveHistory });

  useEffect(() => { setSoundEnabled(prefs.sounds); }, [prefs.sounds]);
  useEffect(() => { document.documentElement.classList.toggle("light", prefs.theme === "light"); }, [prefs.theme]);
  useEffect(() => { purgeOldHistory(); }, []);

  useEffect(() => { stageRef.current = stage; }, [stage]);

  // Session lifecycle (1:1)
  useEffect(() => {
    leavingRef.current = false; // a fresh session may auto-rehost again
    if (!session) return;
    setSessState(session.state);
    return session.on("state", (s) => {
      setSessState(s);
      if (s === "secure") {
        setStage("chat");
        play("connect");
        saveLastRoom(session.roomId, session.role);
        setLastRoom({ roomId: session.roomId, role: session.role, at: Date.now() });
        pushRecentRoom(session.roomId, "peer", `Room ${session.roomId}`, session.role === "host" ? "host" : "member");
        api.addSystem(session.role === "host" ? "Friend joined. Keys verified — end-to-end encryption active." : "Connected. Keys verified — end-to-end encryption active.");
      }
      if (s === "failed") {
        play("error");
        // Host sessions in chat recover via auto-rehost — don't scare the host with a toast each time.
        if (session.error && !(session.role === "host" && stageRef.current === "chat")) toast.error(session.error, { duration: 8000 });
      }
      if (s === "closed") play("leave");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Group lifecycle sounds
  useEffect(() => {
    if (!group) return;
    return group.on("phase", (ph) => {
      if (ph === "ready") play("connect");
      if (ph === "failed") play("error");
      if (ph === "closed") play("leave");
    });
  }, [group]);

  // App-level signaling: publish our offer/answer and listen for the peer's code.
  // Lives here instead of HostWait/GuestJoin so it keeps working mid-chat — e.g. when
  // the host silently re-hosts after a drop, or a guest re-joins after a refresh.
  useEffect(() => {
    if (!session || !session.localCode) return;
    if (session.role === "host") {
      if (sessState !== "waiting") return;
      void publishSignal(session.roomId, "offer", session.localCode);
      return subscribeSignal(session.roomId, "answer", (ans) => {
        if (session.state !== "waiting") return;
        session.acceptAnswer(ans).catch((e: any) => toast.error(e?.message ?? "Could not accept the connection."));
      });
    }
    if (sessState === "waiting") void publishSignal(session.roomId, "answer", session.localCode);
    return undefined;
  }, [session, sessState]);

  // Auto-disconnect on session expiry
  useEffect(() => {
    if (!session || sessState !== "secure") return;
    const t = setTimeout(() => {
      api.addSystem("Session expired — disconnected automatically. Keys deleted.");
      session.close();
    }, prefs.sessionHours * 3600 * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessState === "secure", prefs.sessionHours]);

  // Optional local history
  useEffect(() => {
    if (!roomId || !prefs.saveHistory) return;
    saveHistory(roomId, api.messages.filter((m) => m.kind !== "system").map((m) => (m.file ? { ...m, file: { ...m.file, url: undefined, status: m.file.status === "done" ? "done" : "failed" } } : m)));
  }, [api.messages, roomId, prefs.saveHistory]);
  useEffect(() => { if (!prefs.saveHistory && roomId) clearHistory(roomId); }, [prefs.saveHistory, roomId]);

  // Remember a group's real name once its snapshot arrives (member side).
  useEffect(() => {
    if (!group || group.role !== "member" || !groupApi.snap) return;
    const name = groupApi.snap.meta.name;
    if (name && name !== "New group" && lastNamedRef.current !== group.room + name) {
      lastNamedRef.current = group.room + name;
      pushRecentRoom(group.room, "group", name, "member");
      saveBookmark({ room: group.room, kind: "group", name, at: Date.now() });
    }
  }, [group, groupApi.snap]);

  const loadRoomHistory = (room: string) => {
    if (prefs.saveHistory) { const h = loadHistory(room, prefs.autoDelete24h); if (h.length) api.setMessages(h); }
  };

  const createRoom = useCallback(async (existingRoom?: string) => {
    setBusy(true);
    try {
      session?.close(false);
      const r = existingRoom ?? generateRoomId();
      setRoomId(r);
      if (!existingRoom) { api.setMessages([]); loadRoomHistory(r); }
      setVerified(false);
      const s = await PeerSession.host(r);
      setSession(s);
      pushRecentRoom(r, "peer", `Room ${r}`, "host");
      setStage("host");
    } catch (e: any) {
      toast.error(typeof RTCPeerConnection === "undefined" ? "Your browser doesn't support WebRTC." : `Couldn't create room: ${e?.message ?? e}`);
    } finally { setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, prefs.saveHistory]);

  const joinRoom = useCallback(async (room: string, code: string) => {
    session?.close(false);
    const s = await PeerSession.join(room, code);
    if (room !== roomId) { api.setMessages([]); loadRoomHistory(room); }
    setRoomId(room);
    setVerified(false);
    setSession(s);
    pushRecentRoom(room, "peer", `Room ${room}`, "member");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, roomId, prefs.saveHistory]);

  /** 1:1 join by room id alone (hub recents / saved): fetch the host's live offer first. */
  const openPeerRoom = useCallback(async (room: string) => {
    setBusy(true);
    setJoiningRoom(room);
    try {
      const r = normalizeRoomId(room);
      const { code, closed } = await fetchSignal(r, "offer");
      if (closed) { toast.error("That room was closed by its creator."); return; }
      if (!code) { toast.error(`No host is waiting in room ${r} right now.`); return; }
      await joinRoom(r, code);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not open the room.");
    } finally { setBusy(false); setJoiningRoom(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinRoom]);

  // Room creator: re-host an existing room under its 6-digit code (after leaving/reload).
  // The app-level signaling effect publishes the fresh offer, so the friend's reconnect picks it up.
  const rejoinRoom = useCallback(async (room: string) => {
    setBusy(true);
    try {
      session?.close(false);
      const r = normalizeRoomId(room);
      setRoomId(r);
      api.setMessages([]);
      loadRoomHistory(r);
      setVerified(false);
      const s = await PeerSession.host(r);
      setSession(s);
      pushRecentRoom(r, "peer", `Room ${r}`, "host");
      setStage("host");
      toast(`Room ${r} is live again — waiting for your friend.`);
    } catch (e: any) {
      toast.error(typeof RTCPeerConnection === "undefined" ? "Your browser doesn't support WebRTC." : `Couldn't rejoin room: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Host silently re-hosts the same room and stays in the chat view (messages kept
  // unless this follows a page reload, where saved history is restored instead).
  const rehostInto = useCallback(async (room: string, restoreHistory: boolean) => {
    const r = normalizeRoomId(room);
    const s = await PeerSession.host(r);
    setRoomId(r);
    if (restoreHistory) { api.setMessages([]); loadRoomHistory(r); }
    setVerified(false);
    setSession(s);
    setStage("chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, prefs.saveHistory]);

  // Host keeps the room alive: if the connection dies while chatting, re-host under the
  // same 6-digit code so the friend can rejoin at any time. The chat view stays put.
  useEffect(() => {
    if (!session || session.role !== "host" || stage !== "chat") return;
    if (sessState !== "closed" && sessState !== "failed") return;
    if (rehostingRef.current || leavingRef.current) return;
    rehostingRef.current = true;
    const dead = session;
    const t = window.setTimeout(() => {
      rehostInto(dead.roomId, false)
        .catch((e: any) => toast.error(`Couldn't keep the room open: ${e?.message ?? e}`))
        .finally(() => { rehostingRef.current = false; });
    }, 50);
    return () => { window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessState, stage, rehostInto]);

  // Guest self-healing: if the connection dies mid-chat, re-fetch the host's latest offer
  // and re-join silently (the host auto-re-hosts, so the offer changes). Backs off after 3 tries.
  useEffect(() => {
    if (!session || session.role !== "guest" || stage !== "chat") return;
    if (sessState !== "closed" && sessState !== "failed") return;
    const t = window.setTimeout(() => {
      session.retries++;
      void (async () => {
        const { code, closed } = await fetchSignal(session.roomId, "offer");
        // A different offer means the host re-hosted — join the fresh one.
        if (code && code !== session.remoteOfferCode) {
          joinRoom(session.roomId, code).catch(() => setRetryTick((x) => x + 1));
          return;
        }
        const giveUp = session.retries >= 3;
        if (giveUp) {
          // Give the host a moment — a page reload briefly tombstones the room.
          if (closed) toast.error("The room was closed by its creator.", { duration: 8000 });
          else toast.error("Lost the connection and couldn't reach the room's host. Try rejoining with the 6-digit code in a moment.", { duration: 8000 });
          if (closed) { clearLastRoom(); setLastRoom(null); }
          session.close(false);
          setSession(null);
          setStage("join");
          return;
        }
        setRetryTick((x) => x + 1); // keep waiting — the host may be mid-reload
      })();
    }, 7000);
    return () => { window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessState, stage, retryTick]);

  // ---------- group flows ----------

  /** Host a new group room (wizard) or re-host a saved one (ownership recovery).
   *  Public rooms register with the coordinator: a signed manifest + live lease
   *  make the room joinable/recoverable, and the reception hands out doorbell
   *  offers over the encrypted-coordinator signaling relay. */
  const hostGroup = useCallback(async (meta?: Partial<GroupMeta>, savedRoom?: string) => {
    setBusy(true);
    setCoordHint(null);
    try {
      session?.close(false);
      setSession(null);
      if (group) { await group.closeRoom(); setGroup(null); }
      dropCoordinatorSides();
      const room = savedRoom ? normalizeRoomId(savedRoom) : generateRoomId();
      const saved = savedRoom ? loadGroupSnapshot(savedRoom) : null;
      const isPublic = (meta?.isPublic ?? saved?.snap.meta.isPublic) ?? true;

      // Community rooms bind to the STABLE user identity so the manifest's host
      // commitment matches the live WebRTC peer across restarts.
      let stable: UserIdentity | null = null;
      if (isPublic) stable = await ensureUserIdentity();

      const g = await GroupSession.openAsHost({
        room,
        ...(saved ? {} : { meta: meta ?? {} }),
        saved: saved?.snap ?? null,
        profile: { name: prefs.username, avatar: prefs.avatar, status: prefs.status },
        ...(stable ? { identity: stable.identity } : {}),
      });
      setGroup(g);
      setStage("group");
      pushRecentRoom(room, "group", g.snap.meta.name, "host");
      saveBookmark({ room, kind: "group", name: g.snap.meta.name, at: Date.now() });
      void saveUserName(prefs.username);
      if (!savedRoom) saveLastRoom(room, "host");

      if (stable) {
        const client = coordinator();
        userRef.current = stable;
        activeCommunityRoom.current = room;
        // (Re)register the signed manifest — restart re-own, or a fresh create
        // (also upgrades legacy rooms that never had a manifest).
        const recovery = await loadRecovery();
        const known = recovery.manifests[room];
        let manifest: RoomManifest | null = null;
        try {
          manifest = known
            ? ((await reownCommunityRoom(client, room, stable)) ?? (await registerCommunityRoom(client, room, communityMetaOf(g), stable, known)))
            : (await registerCommunityRoom(client, room, communityMetaOf(g), stable));
        } catch (e: unknown) {
          setCoordHint(`Coordinator registration failed: ${e instanceof Error ? e.message : e}`);
        }
        if (!manifest) {
          setCoordHint((h) => h ?? "Room is open locally, but its coordinator registration failed — joiners can still use the live beacon listing.");
        } else {
          // Reception: answers `want` asks with doorbell offers and feeds the
          // completed handshakes into the group (same trust path as ntfy).
          receptionRef.current = new CoordinatorReception(
            client, room, stable.identity,
            (s) => g.adoptDoorbell(s),
            (message) => setCoordHint(message),
          );
          void receptionRef.current.ensureDoorbell().catch(() => {});
          toast(`"${g.snap.meta.name}" is listed — live while you host. Export its manifest in Settings to add it to a public directory.`);
        }
      } else {
        toast(g.snap.meta.isPublic ? "Room is open and listed in Discover." : "Room is open — share the room code to invite people.");
      }
    } catch (e: any) {
      toast.error(typeof RTCPeerConnection === "undefined" ? "Your browser doesn't support WebRTC." : `Couldn't open the room: ${e?.message ?? e}`);
    } finally { setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, group, prefs, coordinator, dropCoordinatorSides]);

  /** Member: join a room by id. Community rooms (manifest with coordinator
   *  signaling, or a room the coordinator knows) join through the coordinator's
   *  rtc relay; everything else uses the legacy ntfy doorbell. Both paths end
   *  in the same E2EE handshake — the coordinator never sees chat content. */
  const joinGroup = useCallback(async (room: string, manifest?: RoomManifest) => {
    setBusy(true);
    setJoiningRoom(room);
    setCoordHint(null);
    try {
      session?.close(false);
      setSession(null);
      if (group) { await group.closeRoom(); setGroup(null); }
      dropCoordinatorSides();
      const r = normalizeRoomId(room);
      const known = manifest ?? (await loadRecovery()).manifests[r];
      const coordinatorSignaled = !!known?.coordinator?.urls?.length;

      if (coordinatorSignaled || (await probeQuick(coordinator(), r)) === true) {
        const g = await connectCommunity(r, known);
        if (g) {
          setGroup(g);
          setStage("group");
          pushRecentRoom(r, "group", known?.name ?? r, "member");
          return;
        }
        // connectCommunity already surfaced the honest reason; if it fell
        // through without a group AND the room wasn't manifest-listed, try
        // the legacy doorbell before giving up.
        if (coordinatorSignaled) return;
      }

      const { code, closed } = await fetchSignal(r, "offer");
      if (closed) { toast.error("That room was closed by its host."); return; }
      if (!code) { toast.error("No host is waiting for that room right now — it may be offline. Live listings in Discover always show this."); return; }
      const g = await GroupSession.joinAsMember({ room: r, offer: code, profile: { name: prefs.username, avatar: prefs.avatar, status: prefs.status } });
      setGroup(g);
      setStage("group");
      pushRecentRoom(r, "group", r, "member");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not join the room.");
    } finally { setBusy(false); setJoiningRoom(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, group, prefs, coordinator, dropCoordinatorSides]);

  /** Short honest probe: true = live lease, false/null = not available.
   *  Awaits the socket's welcome first — a probe frame sent on a CONNECTING
   *  socket is dropped and the answer would be a fake "not available". */
  const probeQuick = useCallback(async (client: CoordinatorClient, roomId: string): Promise<boolean | null> => {
    if (!(await client.ready(6000))) return null; // couldn't ask — honest
    const waiter = client.onceProbe(roomId, 4000);
    client.probe(roomId);
    return waiter;
  }, []);

  /** Coordinator-joined member flow: reception → offer → verified handshake. */
  const connectCommunity = useCallback(async (r: string, manifest?: RoomManifest): Promise<GroupSession | null> => {
    const client = coordinator();
    memberLinkRef.current?.stop();
    activeCommunityRoom.current = r;
    let offerResolve: ((code: string) => void) | null = null;
    const offerP = new Promise<string>((res) => { offerResolve = res; });
    const link = new CoordinatorMemberLink(client, r, prefs.username, {
      onOffer: (code) => offerResolve?.(code),
      onRoomOffline: () => setCoordHint("This room went offline — its host's lease ended. Try again when the host is back."),
      onError: (message) => setCoordHint(message),
    });
    memberLinkRef.current = link;
    const state = await link.connect();
    if (!state) { memberLinkRef.current = null; activeCommunityRoom.current = null; return null; }
    const code = await offerP;
    memberLinkRef.current = null; // handshake hands off to the session from here
    activeCommunityRoom.current = null;
    try {
      // Listed rooms prove the host: the offer's commitment must match the
      // signed manifest. Unmanifested coordinator rooms (joined by code) skip
      // this — the normal key-verification still applies after connecting.
      if (manifest) await verifyOfferAgainstManifest(code, manifest);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "The host's identity does not match this room's manifest.");
      link.stop();
      return null;
    }
    const g = await GroupSession.joinAsMember({
      room: r,
      offer: code,
      profile: { name: prefs.username, avatar: prefs.avatar, status: prefs.status },
      answerSink: (answerCode) => link.publishAnswer(answerCode),
    });
    // Remember this room's manifest (if any) so rejoin + verification survive reloads.
    if (manifest) {
      const recovery = await loadRecovery();
      await saveRecovery({
        manifests: { ...recovery.manifests, [r]: manifest },
        joinedRoomIds: [...new Set([...recovery.joinedRoomIds, r])],
      });
    }
    return g;
  }, [coordinator, prefs]);

  /** Tear down the open group without leaving the app. Owners unregister the
   *  room: the lease is revoked and members are told it went offline. */
  const dropGroup = useCallback(async () => {
    const g = group;
    setGroup(null);
    setCoordHint(null);
    if (g) await g.closeRoom();
    // Owner of a community room: revoke the lease so the coordinator can tell
    // members the room is honestly offline (never fake availability).
    if (g?.role === "host" && g.snap.meta.isPublic && userRef.current) {
      const client = coordRef.current;
      const recovery = await loadRecovery();
      if (client && recovery.manifests[g.room]) {
        void client.unregister(g.room, userRef.current.signPriv);
      }
    }
    dropCoordinatorSides();
  }, [group, dropCoordinatorSides]);

  const leaveGroup = useCallback(() => {
    void dropGroup();
    setStage("hub");
    toast("You left the room. Group keys deleted.");
  }, [dropGroup]);

  // Member rejoin loop: connection dropped or initial connect timed out —
  // re-fetch the host's latest offer and re-join with the SAME stable membership
  // identity. Honors moderation stops (kicked/banned/full) and "not on roster"
  // rejections: no retry fight. Community rooms rejoin via the coordinator.
  useEffect(() => {
    if (!group || group.role !== "member") return;
    if (groupApi.stopReason) return;
    if (group.phase !== "reconnecting" && group.phase !== "failed") { regroupingRef.current = false; return; }
    if ((group.error ?? "").includes("not on this room's member list")) return; // rejected/removed
    if (regroupingRef.current) return;
    regroupingRef.current = true;
    const dead = group;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          // Community room: the manifest's coordinator signaling is authoritative.
          const known = (await loadRecovery()).manifests[dead.room];
          if (known?.coordinator?.urls?.length) {
            const g = await connectCommunity(dead.room, known);
            if (g) { setGroup(g); return; }
            if (groupRetry >= 2) { toast.error("Lost the room and couldn't reach its coordinator. Try again from the hub in a moment.", { duration: 8000 }); void dropGroup(); setStage("hub"); return; }
            setGroupRetry((x) => x + 1);
            return;
          }
          const { code, closed } = await fetchSignal(dead.room, "offer");
          if (closed) { toast.error("The room was closed by its host.", { duration: 8000 }); void dropGroup(); setStage("hub"); return; }
          if (!code) {
            if (groupRetry >= 2) { toast.error("Lost the room and couldn't reach its host. Try again from the hub in a moment.", { duration: 8000 }); void dropGroup(); setStage("hub"); return; }
            setGroupRetry((x) => x + 1);
            return;
          }
          // joinAsMember re-loads this room's stable GroupIdentity from IndexedDB.
          const g = await GroupSession.joinAsMember({ room: dead.room, offer: code, profile: { name: prefs.username, avatar: prefs.avatar, status: prefs.status } });
          setGroup(g);
        } catch {
          if (groupRetry >= 2) { toast.error("Lost the room and couldn't reach its host. Try again from the hub in a moment.", { duration: 8000 }); void dropGroup(); setStage("hub"); }
          else setGroupRetry((x) => x + 1);
        } finally {
          regroupingRef.current = false;
        }
      })();
    }, 7000);
    return () => { window.clearTimeout(t); regroupingRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, group?.phase, group?.error, groupApi.stopReason, groupRetry, dropGroup, connectCommunity]);

  // One-click return to the last 1:1 room (kept across reloads).
  const rejoinLast = useCallback(async () => {
    if (!lastRoom || busy) return;
    if (lastRoom.role === "host") { await rejoinRoom(lastRoom.roomId); return; }
    await openPeerRoom(lastRoom.roomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRoom, busy, openPeerRoom, rejoinRoom]);

  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (mode === "create") {
      // Reload of a live room (link carried ?mode=create): silently re-host the same
      // room instead of minting a new code, so the friend's reconnect still works.
      const lr = lastRoom;
      if (lr?.role === "host" && Date.now() - lr.at < 10 * 60 * 1000) {
        void rehostInto(lr.roomId, true).catch((e: any) => toast.error(`Couldn't reopen room ${lr.roomId}: ${e?.message ?? e}`));
      } else {
        void createRoom();
      }
    }
    else if (mode === "join" || initialCode) setStage("join");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leave = useCallback(() => {
    leavingRef.current = true; // intentional leave — never auto-rehost
    if (session?.role === "host") {
      // The creator is leaving: tombstone the room so joiners stop retrying it.
      void publishSignal(session.roomId, "offer", ROOM_CLOSED);
      clearLastRoom();
      setLastRoom(null);
    }
    session?.close(true);
    setSession(null);
    setVerified(false);
    setBlocked(false);
    setStage("hub");
    setSettings({ open: false });
    if (!prefs.saveHistory) api.setMessages([]);
    toast("You left the room. Session keys deleted.");
  }, [session, prefs.saveHistory, api]);

  const reconnect = useCallback(() => {
    setSettings({ open: false });
    if (session?.role === "guest") { session.close(false); setSession(null); setStage("join"); toast("Connection lost. Enter the 6-digit room code to reconnect."); }
    else void createRoom(roomId || undefined);
  }, [session, roomId, createRoom]);

  const exportChat = () => {
    const data = { app: "Pixolark", room: roomId, exportedAt: new Date().toISOString(), messages: api.messages.map((m) => ({ ...m, file: m.file ? { name: m.file.name, size: m.file.size, mime: m.file.mime } : undefined })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `pixolark-${roomId || "chat"}-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const clearChat = () => {
    api.messages.forEach((m) => m.file?.url && URL.revokeObjectURL(m.file.url));
    api.setMessages([]);
    if (roomId) clearHistory(roomId);
    toast("Chat cleared on this device.");
  };

  const clearAll = () => {
    clearAllLocalData();
    coordRef.current?.disconnect();
    coordRef.current = null;
    userRef.current = null;
    dropCoordinatorSides();
    setCoordState({ s: "idle" });
    clearChat();
    leavingRef.current = true;
    session?.close(true);
    void dropGroup();
    setLastRoom(null);
    setSession(null);
    setStage("hub");
    const fresh = defaultPrefs();
    setPrefsState(fresh); savePrefs(fresh);
    setSettings({ open: false });
    toast("All local data cleared.");
  };

  const reloadPrefsFromDisk = useCallback(() => {
    setPrefsState(loadPrefs());
    setLastRoom(loadLastRoom());
    toast("Local data restored.");
  }, []);

  // Clean up blob URLs + sessions on unmount / tab close.
  // Groups do NOT tombstone here: a page reload is followed by auto-rehost, and members'
  // retry loops + stale discovery beacons handle the gap honestly (host shows offline).
  useEffect(() => {
    const h = () => {
      leavingRef.current = true; // page going away — never auto-rehost
      if (session?.role === "host") {
        // Tab closed or reloaded: tombstone so guests don't retry a dead room.
        // If this was only a reload, the host's rejoin supersedes the tombstone.
        void publishSignal(session.roomId, "offer", ROOM_CLOSED);
      }
      session?.close(true);
      void group?.closeRoom();
    };
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, [session, group]);

  const inHub = stage === "hub" || stage === "group-create";
  return (
    <div className="min-h-dvh">
      {inHub && <PixelBackground />}

      {stage === "hub" && (
        <Hub
          prefs={prefs} busy={busy} lastRoom={lastRoom} joiningRoom={joiningRoom}
          activeGroup={group ? { room: group.room, name: groupApi.snap?.meta.name ?? group.room, role: group.role } : null}
          tab={hubTab} setTab={setHubTab}
          onRejoinLast={() => void rejoinLast()}
          onCreateRoom={() => void createRoom()}
          onJoinRoom={() => setStage("join")}
          onCreateGroup={() => setStage("group-create")}
          onHostGroupAgain={(room) => void hostGroup(undefined, room)}
          onJoinGroup={(room) => void joinGroup(room)}
          onJoinGroupManifest={(room, manifest) => void joinGroup(room, manifest)}
          probeRoom={(roomId) => probeQuick(coordinator(), roomId)}
          onJoinPeer={(room) => void openPeerRoom(room)}
          onReturnToGroup={() => setStage("group")}
          onLeaveGroup={leaveGroup}
          onOpenSettings={() => setSettings({ open: true })}
        />
      )}

      {stage === "group-create" && (
        <div className="px-4 py-6">
          <GroupCreate
            busy={busy}
            onCreate={(meta) => void hostGroup(meta)}
            onCancel={() => setStage("hub")}
          />
        </div>
      )}

      {stage === "host" && session && session.role === "host" && <HostWait session={session} onBack={leave} />}
      {stage === "host" && busy && <div className="py-20"><div className="text-center">Generating room</div></div>}
      {stage === "join" && (
        <GuestJoin
          session={session?.role === "guest" ? session : null}
          onJoin={joinRoom}
          onRejoin={rejoinRoom}
          onBack={leave}
          initialRoom={initialRoom || roomId}
          initialCode={initialCode}
        />
      )}
      {stage === "chat" && (
        <ChatView
          api={api} session={session} sessState={sessState} prefs={prefs} setPrefs={setPrefs} roomId={roomId}
          verified={verified} muted={muted} blocked={blocked}
          onSettings={(tab) => setSettings({ open: true, tab })} onLeave={leave} onReconnect={reconnect}
        />
      )}
      {stage === "group" && group && (
        <GroupView
          group={group} api={groupApi} prefs={prefs} setPrefs={setPrefs} muted={muted}
          coordHint={coordHint}
          onLeave={leaveGroup}
          onBack={() => { setStage("hub"); setHubTab("groups"); }}
        />
      )}
      {stage === "group" && !group && (
        <div className="flex min-h-dvh items-center justify-center p-4 text-sm text-muted-foreground">The room is closed.</div>
      )}

      <CallOverlay api={api} session={session} peer={api.peer} />
      <SettingsPanel
        open={settings.open} initialTab={settings.tab} onClose={() => setSettings({ open: false })}
        prefs={prefs} setPrefs={setPrefs} session={session?.isSecure ? session : stage === "chat" ? session : null}
        group={group}
        muted={muted} setMuted={setMuted} blocked={blocked} setBlocked={setBlocked}
        verified={verified} setVerified={(v) => { setVerified(v); if (v) api.addSystem("You marked this connection as verified."); }}
        onClearChat={clearChat} onExport={exportChat} onClearAll={clearAll} onReconnect={reconnect} onLeave={leave}
        onBackupImported={reloadPrefsFromDisk}
      />
    </div>
  );
}
