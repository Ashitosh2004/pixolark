/**
 * IndexedDB storage for Pixolark's local-only data.
 * - Group membership identity: a pseudonymous ECDH key pair stored as NON-EXTRACTABLE
 *   CryptoKeys. It can never decrypt messages by itself — it only proves "this device
 *   returned to the group" so roles/roster survive reconnects. Session/message keys
 *   remain memory-only.
 * - Encrypted chat history: per-room AES-GCM key (also non-extractable) + message logs.
 * Drafts, prefs and room bookmarks stay in localStorage (storage.ts).
 */
import { b64url, fromB64url } from "./bytes";
import { commitmentOf } from "./crypto";

const DB_NAME = "pixolark";
const DB_VERSION = 1;
const STORE_KEYS = "keys";
const STORE_HIST = "history";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS);
      if (!db.objectStoreNames.contains(STORE_HIST)) db.createObjectStore(STORE_HIST);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
      }),
  );
}

/** Stable, non-extractable ECDH identity for one group on this device. */
export interface GroupIdentity {
  keyPair: CryptoKeyPair;
  publicRaw: Uint8Array<ArrayBuffer>;
  memberId: string;
}

export async function loadGroupIdentity(roomId: string): Promise<GroupIdentity | null> {
  try {
    const keyPair = await tx<CryptoKeyPair | undefined>(STORE_KEYS, "readonly", (s) => s.get(`group-id:${roomId}`));
    if (!keyPair) return null;
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    return { keyPair, publicRaw, memberId: await commitmentOf(publicRaw) };
  } catch {
    return null;
  }
}

export async function createGroupIdentity(roomId: string): Promise<GroupIdentity> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
  await tx(STORE_KEYS, "readwrite", (s) => s.put(keyPair, `group-id:${roomId}`));
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, publicRaw, memberId: await commitmentOf(publicRaw) };
}

/** Per-room AES-GCM key for encrypting LOCAL history at rest. Non-extractable, IDB-stored. */
export async function loadHistoryKey(roomId: string): Promise<CryptoKey | null> {
  try {
    return (await tx<CryptoKey | undefined>(STORE_KEYS, "readonly", (s) => s.get(`hist-key:${roomId}`))) ?? null;
  } catch {
    return null;
  }
}

export async function ensureHistoryKey(roomId: string): Promise<CryptoKey> {
  const existing = await loadHistoryKey(roomId);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await tx(STORE_KEYS, "readwrite", (s) => s.put(key, `hist-key:${roomId}`));
  return key;
}

export interface StoredMessage {
  id: string;
  senderId: string;
  senderName?: string | undefined;
  kind: string;
  ts: number;
  /** Serialized, already-decrypted content small enough for local storage. */
  data: string;
}

export async function loadHistoryLog(roomId: string, limit = 500): Promise<StoredMessage[]> {
  try {
    const all = (await tx<StoredMessage[] | undefined>(STORE_HIST, "readonly", (s) => s.get(`log:${roomId}`))) ?? [];
    return all.slice(-limit);
  } catch {
    return [];
  }
}

export async function appendHistoryLog(roomId: string, key: CryptoKey, entry: Omit<StoredMessage, "data"> & { plain: string }): Promise<void> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(entry.plain)));
    const item: StoredMessage = { id: entry.id, senderId: entry.senderId, senderName: entry.senderName, kind: entry.kind, ts: entry.ts, data: b64url(concatBytes(iv, ct)) };
    const all = (await tx<StoredMessage[] | undefined>(STORE_HIST, "readonly", (s) => s.get(`log:${roomId}`))) ?? [];
    if (all.some((m) => m.id === item.id)) return;
    all.push(item);
    await tx(STORE_HIST, "readwrite", (s) => s.put(all.slice(-1000), `log:${roomId}`));
  } catch {
    // storage failures never break chat
  }
}

export async function decryptStored(key: CryptoKey, item: StoredMessage): Promise<string> {
  const raw = fromB64url(item.data);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return new TextDecoder().decode(pt);
}

export async function clearHistoryLog(roomId: string): Promise<void> {
  try {
    await tx(STORE_HIST, "readwrite", (s) => s.delete(`log:${roomId}`));
  } catch { /* ignore */ }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
