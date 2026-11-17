/**
 * Local encrypted recovery registry — the user's database-free memory.
 *
 * Everything here lives ONLY on this device:
 * - a device-local AES-GCM key (NON-extractable, in IndexedDB) encrypts the
 *   whole payload at rest; nothing is ever sent to any backend automatically;
 * - the payload holds: identity recovery material (ECDH identity + manifest
 *   signing key, as base64 PKCS8), owned/joined room manifests, last
 *   coordinator, drafts, pins, prefs and recovery metadata;
 * - "export" re-encrypts the payload under a password (PBKDF2-SHA-256,
 *   600k iterations) so backups and device-to-device transfers work even
 *   after the browser's storage is cleared;
 * - "import" decrypts such a backup and writes it into THIS device's registry.
 *
 * Honesty: if a room's only copies were lost (cleared storage, no backup,
 * no surviving device), recovery is genuinely impossible and the UI must say
 * so — nothing here pretends otherwise.
 */
import { b64url, fromB64url, concat } from "./bytes";
import { loadHistoryKey, ensureHistoryKey, clearAllLocalData, openPixolarkDb } from "./idb";
import type { RoomManifest } from "./manifest";

const PBKDF2_ITERATIONS = 600_000;

export interface RecoveryPayload {
  v: 1;
  identity: {
    name: string;
    /** Pixolark ID (hex commitment of the ECDH identity). */
    pixolarkId: string;
    /** ECDH identity PRIVATE key (pkcs8, b64url) — exportable clone used ONLY for backup/transfer. */
    ecdhPkcs8: string;
    /** Room-manifest signing key (pkcs8, b64url) — the owner's proof-of-ownership secret. */
    signPkcs8: string;
  } | null;
  /** roomId → manifest for rooms we own or joined (public data, but kept here so recovery is instant). */
  manifests: Record<string, RoomManifest>;
  ownedRoomIds: string[];
  joinedRoomIds: string[];
  lastCoordinator: string;
  /** Last selected room per surface, e.g. { chat: "123456", discover: "442311" } */
  lastSelectedRoom: Record<string, string>;
  drafts: Record<string, string>;
  pinned: Record<string, string[]>;
  prefs: Record<string, string | number | boolean>;
  savedAt: number;
}

function emptyPayload(): RecoveryPayload {
  return {
    v: 1,
    identity: null,
    manifests: {},
    ownedRoomIds: [],
    joinedRoomIds: [],
    lastCoordinator: "",
    lastSelectedRoom: {},
    drafts: {},
    pinned: {},
    prefs: {},
    savedAt: 0,
  };
}

// ---------- device-local encryption key ----------

const IDB_RECOVERY_STORE = "recovery";
const KEY_ID = "device-key";
const BLOB_ID = "blob";

function idbTx<T>(run: (s: IDBObjectStore) => IDBRequest, mode: IDBTransactionMode = "readonly"): Promise<T> {
  return openPixolarkDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(IDB_RECOVERY_STORE, mode);
        const r = run(t.objectStore(IDB_RECOVERY_STORE));
        r.onsuccess = () => {
          db.close();
          resolve(r.result as T);
        };
        r.onerror = () => {
          db.close();
          reject(r.error ?? new Error("IndexedDB request failed"));
        };
      }),
  );
}

function idbPut(value: unknown, id: string): Promise<void> {
  return idbTx<void>((s) => s.put(value, id), "readwrite");
}

/** Non-extractable AES-GCM key that encrypts the payload at rest. */
async function ensureDeviceKey(): Promise<CryptoKey> {
  const existing = await idbTx<CryptoKey | undefined>((s) => s.get(KEY_ID));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idbPut(key, KEY_ID);
  return key;
}

// ---------- payload read/write ----------

async function encryptWith(key: CryptoKey, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return concat(iv, ct);
}

async function decryptWith(key: CryptoKey, ivCt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivCt.slice(0, 12) }, key, ivCt.slice(12));
  return new Uint8Array(pt);
}

export async function loadRecovery(): Promise<RecoveryPayload> {
  try {
    const key = await ensureDeviceKey();
    const raw = await idbTx<Uint8Array | undefined>((s) => s.get(BLOB_ID));
    if (!raw) return emptyPayload();
    const pt = await decryptWith(key, new Uint8Array(raw));
    return { ...emptyPayload(), ...(JSON.parse(new TextDecoder().decode(pt)) as RecoveryPayload) };
  } catch {
    return emptyPayload(); // corrupt/missing registry is an honest empty state
  }
}

export async function saveRecovery(patch: Partial<RecoveryPayload>): Promise<void> {
  const current = await loadRecovery();
  const next: RecoveryPayload = { ...current, ...patch, v: 1, savedAt: Date.now() };
  const key = await ensureDeviceKey();
  const blob = await encryptWith(key, new TextEncoder().encode(JSON.stringify(next)));
  await idbPut(blob, BLOB_ID);
}

// ---------- password-protected export / import ----------

export interface EncryptedBackup {
  v: 1;
  kind: "pixolark-backup";
  kdf: { alg: "PBKDF2-SHA256"; iterations: number; salt: string };
  iv: string;
  data: string;
}

async function derivePasswordKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypted, downloadable backup — password REQUIRED (min 8 chars). */
export async function exportRecovery(password: string): Promise<EncryptedBackup> {
  if (password.length < 8) throw new Error("Backup password must be at least 8 characters.");
  const payload = await loadRecovery();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derivePasswordKey(password, salt);
  const blob = await encryptWith(key, new TextEncoder().encode(JSON.stringify(payload)));
  const backup: EncryptedBackup = {
    v: 1,
    kind: "pixolark-backup",
    kdf: { alg: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, salt: b64url(salt) },
    iv: "",
    data: "",
  };
  backup.iv = b64url(blob.slice(0, 12));
  backup.data = b64url(blob.slice(12));
  return backup;
}

/** Restore from a password-protected backup onto THIS device. */
export async function importRecovery(backup: unknown, password: string): Promise<RecoveryPayload> {
  const b = backup as Partial<EncryptedBackup> | null;
  if (!b || b.kind !== "pixolark-backup" || b.v !== 1 || typeof b.data !== "string") {
    throw new Error("Not a Pixolark backup file.");
  }
  const salt = fromB64url(b.kdf?.salt ?? "");
  const key = await derivePasswordKey(password, salt);
  let pt: Uint8Array<ArrayBuffer>;
  try {
    pt = await decryptWith(key, concat(fromB64url(b.iv ?? ""), fromB64url(b.data)));
  } catch {
    throw new Error("Wrong password or corrupted backup.");
  }
  const payload = { ...emptyPayload(), ...(JSON.parse(new TextDecoder().decode(pt)) as RecoveryPayload) };
  // Write into THIS device's registry (fresh device key if needed).
  await saveRecovery(payload);
  return payload;
}

/** Clear ONLY the recovery registry (identity, manifests, prefs). */
export async function clearRecovery(): Promise<void> {
  await idbTx<void>((s) => s.delete(BLOB_ID), "readwrite");
  await idbTx<void>((s) => s.delete(KEY_ID), "readwrite");
}

/** Nuke all local data: recovery + encrypted history + keys + localStorage. */
export async function clearEverything(): Promise<void> {
  await clearRecovery();
  await clearAllLocalData();
}

// ---------- history-key convenience (per-room local history stays encrypted) ----------

export { ensureHistoryKey, loadHistoryKey };
