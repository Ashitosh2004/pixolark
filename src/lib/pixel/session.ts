/**
 * PeerSession: one WebRTC peer connection + encrypted DataChannel.
 * Signaling is manual (copy/QR connection codes). After the DataChannel opens, peers
 * exchange ECDH public keys, verify them against commitments carried in the codes,
 * and from then on every byte on the channel is AES-GCM encrypted.
 * The `Signaler` abstraction lets a self-hosted signaling server replace manual codes later.
 */
import { b64url, fromB64url } from "./bytes";
import { CodeError, OFFER_TTL_MS, decodeConnection, dtlsFingerprints, encodeConnection, type ConnectionPayload } from "./codec";
import { createIdentity, commitmentOf, deriveSessionKeys, openFrame, packEnvelope, sealFrame, unpackEnvelope, type Identity, type SessionKeys } from "./crypto";

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type SessionState =
  | "preparing" // generating keys + offer/answer
  | "waiting" // code shown, waiting for the other side
  | "connecting" // ICE/DTLS in progress
  | "handshake" // channel open, exchanging keys
  | "secure" // E2EE active
  | "reconnecting"
  | "closed"
  | "failed";

export interface Envelope { t: string; [k: string]: any }

type Events = {
  state: SessionState;
  message: { header: any; body: Uint8Array<ArrayBuffer> };
  track: MediaStream;
  presence: boolean;
};

const CONNECT_TIMEOUT_MS = 45_000;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

export class PeerSession {
  state: SessionState = "preparing";
  error: string | null = null;
  fingerprint: string | null = null;
  localCode: string | null = null;
  readonly roomId: string;
  readonly role: "host" | "guest";
  sid = "";
  codeExpiresAt = 0;
  peerOnline = false;
  remoteStream = new MediaStream();
  localStream: MediaStream | null = null;
  readonly pc: RTCPeerConnection;

  private dc: RTCDataChannel | null = null;
  private identity!: Identity;
  private keys: SessionKeys | null = null;
  private peerCommit: string | null = null;
  private answered = false;
  private sendSeq = 0;
  private recvSeq = 0;
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();
  private listeners: { [K in keyof Events]?: Set<(v: Events[K]) => void> } = {};
  private timers: number[] = [];
  private lastSeen = 0;
  private makingOffer = false;
  private remoteSdp = "";

  private constructor(roomId: string, role: "host" | "guest") {
    this.roomId = roomId;
    this.role = role;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.addEventListener("connectionstatechange", () => this.onPcState());
    this.pc.addEventListener("track", (e) => {
      if (!this.remoteStream.getTracks().includes(e.track)) this.remoteStream.addTrack(e.track);
      e.track.addEventListener("ended", () => { this.remoteStream.removeTrack(e.track); this.emit("track", this.remoteStream); });
      this.emit("track", this.remoteStream);
    });
  }

  on<K extends keyof Events>(ev: K, fn: (v: Events[K]) => void) {
    ((this.listeners[ev] ??= new Set() as any) as Set<(v: Events[K]) => void>).add(fn);
    return () => { (this.listeners[ev] as Set<(v: Events[K]) => void> | undefined)?.delete(fn); };
  }
  private emit<K extends keyof Events>(ev: K, v: Events[K]) {
    (this.listeners[ev] as Set<(v: Events[K]) => void> | undefined)?.forEach((fn) => fn(v));
  }
  private setState(s: SessionState, error?: string) {
    if (this.state === "failed" || (this.state === "closed" && s !== "failed")) return;
    this.state = s;
    if (error) this.error = error;
    this.emit("state", s);
  }

  /** Host: create offer + connection code. */
  static async host(roomId: string): Promise<PeerSession> {
    const s = new PeerSession(roomId, "host");
    s.identity = await createIdentity();
    s.sid = b64url(crypto.getRandomValues(new Uint8Array(9)));
    s.attachChannel(s.pc.createDataChannel("pixelchat", { ordered: true }));
    await s.pc.setLocalDescription(await s.pc.createOffer());
    await s.waitForIce();
    s.codeExpiresAt = Date.now() + OFFER_TTL_MS;
    s.localCode = await encodeConnection({
      v: 1, kind: "offer", room: roomId, sdp: s.pc.localDescription!.sdp, commit: s.identity.commitment, exp: s.codeExpiresAt, sid: s.sid,
    });
    s.setState("waiting");
    s.timers.push(window.setTimeout(() => {
      if (s.state === "waiting") s.setState("failed", "Session expired: nobody answered within 15 minutes. Create a new room.");
    }, OFFER_TTL_MS));
    return s;
  }

  /** Guest: consume an offer code, produce an answer code. */
  static async join(roomId: string, offerCode: string): Promise<PeerSession> {
    const p = await decodeConnection(offerCode);
    if (p.kind !== "offer") throw new CodeError("That is an answer code. Paste the code from the room creator.");
    if (p.room !== roomId) throw new CodeError(`This code belongs to room ${p.room}, not ${roomId}. Check the Room ID.`);
    const s = new PeerSession(roomId, "guest");
    s.identity = await createIdentity();
    s.sid = p.sid;
    s.peerCommit = p.commit;
    s.pc.addEventListener("datachannel", (e) => s.attachChannel(e.channel));
    await s.pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
    s.remoteSdp = p.sdp;
    await s.pc.setLocalDescription(await s.pc.createAnswer());
    await s.waitForIce();
    s.codeExpiresAt = Date.now() + OFFER_TTL_MS;
    s.localCode = await encodeConnection({
      v: 1, kind: "answer", room: roomId, sdp: s.pc.localDescription!.sdp, commit: s.identity.commitment, exp: s.codeExpiresAt, sid: s.sid,
    });
    s.setState("waiting");
    s.armConnectTimeout(OFFER_TTL_MS);
    return s;
  }

  /** Host: apply the guest's answer code. */
  async acceptAnswer(code: string) {
    const p: ConnectionPayload = await decodeConnection(code);
    if (p.kind !== "answer") throw new CodeError("That is your own offer code. Paste the ANSWER code your friend sends back.");
    if (p.room !== this.roomId) throw new CodeError("This answer belongs to a different room.");
    if (p.sid !== this.sid) throw new CodeError("This answer was made for an older invite. Ask your friend to scan the current one.");
    if (this.answered) throw new CodeError("A peer is already connected to this invite. Duplicate connection blocked.");
    this.answered = true;
    this.peerCommit = p.commit;
    this.remoteSdp = p.sdp;
    await this.pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
    this.setState("connecting");
    this.armConnectTimeout(CONNECT_TIMEOUT_MS);
  }

  private armConnectTimeout(ms: number) {
    this.timers.push(window.setTimeout(() => {
      if (this.state !== "secure" && this.state !== "closed") {
        this.setState("failed", "Connection timed out. Your networks may block direct peer-to-peer links (strict NAT/firewall). Try another network or create a new room.");
        this.close(false);
      }
    }, ms));
  }

  private waitForIce(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === "complete") return resolve();
      const done = () => { this.pc.removeEventListener("icegatheringstatechange", check); resolve(); };
      const check = () => { if (this.pc.iceGatheringState === "complete") done(); };
      this.pc.addEventListener("icegatheringstatechange", check);
      setTimeout(done, 5000);
    });
  }

  private attachChannel(dc: RTCDataChannel) {
    if (this.dc) { dc.close(); return; } // duplicate channel guard
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen = () => {
      this.setState("handshake");
      dc.send(JSON.stringify({ t: "hello", v: 1, pub: b64url(this.identity.publicRaw) }));
    };
    dc.onclose = () => {
      if (this.state !== "failed" && this.state !== "closed") this.setState("closed", "The other person left or the connection dropped.");
      this.peerOnline = false;
      this.emit("presence", false);
    };
    dc.onmessage = (e) => { this.recvChain = this.recvChain.then(() => this.onRaw(e.data)).catch(() => {}); };
  }

  private async onRaw(data: string | ArrayBuffer) {
    if (typeof data === "string") {
      if (this.keys) return this.fail("Received unencrypted data after the secure handshake. Communication stopped.");
      let msg: any;
      try { msg = JSON.parse(data); } catch { return this.fail("Invalid handshake data."); }
      if (msg.t !== "hello" || !msg.pub) return this.fail("Invalid handshake data.");
      const peerPub = fromB64url(msg.pub);
      const commit = await commitmentOf(peerPub);
      if (!this.peerCommit || commit !== this.peerCommit) {
        return this.fail("KEY MISMATCH: the peer's encryption key does not match the connection code. Someone may be tampering with the connection. Communication stopped.");
      }
      const localSdp = this.pc.localDescription?.sdp ?? "";
      const ctx = this.roomId + "|" + [dtlsFingerprints(localSdp), dtlsFingerprints(this.remoteSdp)].sort().join("|");
      this.keys = await deriveSessionKeys(this.identity, peerPub, this.role, ctx);
      this.fingerprint = this.keys.fingerprint;
      this.lastSeen = Date.now();
      this.peerOnline = true;
      this.setupRenegotiation();
      this.setState("secure");
      this.emit("presence", true);
      this.timers.push(window.setInterval(() => this.heartbeat(), 5000));
      return;
    }
    if (!this.keys) return this.fail("Received encrypted data before the key exchange.");
    try {
      const { seq, plaintext } = await openFrame(this.keys.recvKey, new Uint8Array(data), this.recvSeq);
      this.recvSeq = seq;
      this.lastSeen = Date.now();
      if (!this.peerOnline) { this.peerOnline = true; this.emit("presence", true); }
      const { header, body } = unpackEnvelope(plaintext);
      if (header.t === "ping") return;
      if (header.t === "sdp") return this.onRemoteSdp(header.desc);
      if (header.t === "ice") { try { await this.pc.addIceCandidate(header.c); } catch { /* ignored */ } return; }
      this.emit("message", { header, body });
    } catch {
      this.fail("A message failed authentication (tampered, replayed or corrupted). Communication stopped for your safety.");
    }
  }

  private heartbeat() {
    if (this.state !== "secure" && this.state !== "reconnecting") return;
    void this.send({ t: "ping" }).catch(() => {});
    const online = Date.now() - this.lastSeen < 15_000;
    if (online !== this.peerOnline) { this.peerOnline = online; this.emit("presence", online); }
  }

  private setupRenegotiation() {
    const polite = this.role === "guest";
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        await this.send({ t: "sdp", desc: this.pc.localDescription!.toJSON() });
      } catch { /* ignore */ } finally { this.makingOffer = false; }
    };
    this.pc.onicecandidate = (e) => { if (e.candidate) void this.send({ t: "ice", c: e.candidate.toJSON() }).catch(() => {}); };
    (this as any)._polite = polite;
  }

  private async onRemoteSdp(desc: RTCSessionDescriptionInit) {
    const polite = (this as any)._polite as boolean;
    const collision = desc.type === "offer" && (this.makingOffer || this.pc.signalingState !== "stable");
    if (!polite && collision) return;
    await this.pc.setRemoteDescription(desc);
    if (desc.type === "offer") {
      await this.pc.setLocalDescription();
      await this.send({ t: "sdp", desc: this.pc.localDescription!.toJSON() });
    }
  }

  private onPcState() {
    const st = this.pc.connectionState;
    if (st === "connecting" && this.state === "waiting" && (this.role === "guest" || this.answered)) this.setState("connecting");
    if (st === "disconnected" && this.state === "secure") this.setState("reconnecting");
    if (st === "connected" && this.state === "reconnecting") this.setState("secure");
    if (st === "failed") {
      if (this.keys && this.dc?.readyState === "open") { this.pc.restartIce(); this.setState("reconnecting"); }
      else if (this.state !== "closed") this.setState("failed", "Peer-to-peer connection failed. A direct route between your networks could not be found.");
    }
  }

  private fail(msg: string) {
    this.setState("failed", msg);
    this.close(false);
  }

  get isSecure() { return this.state === "secure" || this.state === "reconnecting"; }
  get bufferedAmount() { return this.dc?.bufferedAmount ?? 0; }

  /** Encrypt and send. Never sends plaintext; throws if the channel isn't secure. */
  send(header: Envelope, body?: Uint8Array): Promise<void> {
    const job = this.sendChain.then(async () => {
      if (!this.keys || !this.dc || this.dc.readyState !== "open") throw new Error("Not connected securely");
      if (this.dc.bufferedAmount > HIGH_WATER) {
        await new Promise<void>((res) => {
          const h = () => { this.dc?.removeEventListener("bufferedamountlow", h); res(); };
          this.dc!.addEventListener("bufferedamountlow", h);
        });
      }
      const frame = await sealFrame(this.keys.sendKey, ++this.sendSeq, packEnvelope(header, body));
      this.dc.send(frame);
    });
    this.sendChain = job.catch(() => {});
    return job;
  }

  async addLocalMedia(stream: MediaStream) {
    this.localStream = stream;
    for (const t of stream.getTracks()) this.pc.addTrack(t, stream);
  }
  async replaceVideoTrack(track: MediaStreamTrack) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }
  stopLocalMedia() {
    for (const s of this.pc.getSenders()) if (s.track) { try { this.pc.removeTrack(s); } catch { /* */ } }
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    for (const t of this.remoteStream.getTracks()) this.remoteStream.removeTrack(t);
    this.emit("track", this.remoteStream);
  }

  async diagnostics() {
    const out: Record<string, string> = {
      "Session state": this.state,
      "Peer connection": this.pc.connectionState,
      "ICE connection": this.pc.iceConnectionState,
      "ICE gathering": this.pc.iceGatheringState,
      "Signaling": this.pc.signalingState,
      "DataChannel": this.dc?.readyState ?? "none",
      "Buffered bytes": String(this.dc?.bufferedAmount ?? 0),
      "Frames sent / received": `${this.sendSeq} / ${this.recvSeq}`,
      "Role": this.role,
    };
    try {
      const stats = await this.pc.getStats();
      let pair: any;
      stats.forEach((r: any) => { if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded") pair = r; });
      if (pair) {
        const l: any = stats.get(pair.localCandidateId);
        const r: any = stats.get(pair.remoteCandidateId);
        out["Round-trip time"] = pair.currentRoundTripTime != null ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : "n/a";
        out["Local route"] = l ? `${l.candidateType} / ${l.protocol}` : "n/a";
        out["Remote route"] = r ? `${r.candidateType} / ${r.protocol}` : "n/a";
        out["Bytes sent / received"] = `${pair.bytesSent ?? 0} / ${pair.bytesReceived ?? 0}`;
      }
    } catch { /* ignore */ }
    return out;
  }

  async rttMs(): Promise<number | null> {
    try {
      const stats = await this.pc.getStats();
      let rtt: number | null = null;
      stats.forEach((r: any) => { if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime * 1000; });
      return rtt;
    } catch { return null; }
  }

  close(sendBye = true) {
    if (sendBye && this.isSecure) void this.send({ t: "bye" }).catch(() => {});
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.localStream?.getTracks().forEach((t) => t.stop());
    setTimeout(() => { try { this.dc?.close(); this.pc.close(); } catch { /* */ } }, sendBye ? 150 : 0);
    this.keys = null; // drop session keys from memory
    if (this.state !== "failed") this.setState("closed");
  }
}
