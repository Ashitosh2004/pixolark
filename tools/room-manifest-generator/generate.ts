/**
 * Room manifest generator — the owner's CLI for creating, renewing and
 * republishing signed room manifests without ever touching a database.
 *
 * Every invocation:
 *   1. loads (or creates) the owner's ECDSA signing key — a SECRET, stored
 *      locally as base64 PKCS8, never committed, never sent anywhere;
 *   2. builds the manifest's public fields;
 *   3. signs it and self-verifies the result before writing;
 *   4. writes the signed manifest JSON for the directory publisher.
 *
 * Examples:
 *   bun tools/room-manifest-generator/generate.ts --roomId 123456 --name "Pixel Garden" \
 *     --category "General Chat" --region India --subRegion Maharashtra --city Kolhapur \
 *     --languages English,Marathi --host-commitment <hex> --key keys/123456.owner.pkcs8.b64
 *
 *   # renew (bump timestamps + expiry, same owner key):
 *   ... --renew --key keys/123456.owner.pkcs8.b64 --out rooms/123456.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { b64url, fromB64url } from "../../src/lib/pixel/bytes";
import { commitmentOf } from "../../src/lib/pixel/crypto";
import { isValidRoomId, normalizeRoomId } from "../../src/lib/pixel/codec";
import {
  exportSigningPrivateKeyPkcs8,
  exportSigningPublicKeyRaw,
  generateSigningKey,
  importSigningPrivateKeyPkcs8,
  manifestSections,
  ownerFingerprint,
  signManifest,
  verifyManifest,
  verifyOwnerFingerprint,
} from "../../src/lib/pixel/manifest";
import { die, exists, flag, flags, parseArgs, readJson, splitList, writeJson } from "../lib/cli";

const args = parseArgs(process.argv.slice(2));

const roomId = normalizeRoomId(flag(args, "roomId") ?? "");
if (!isValidRoomId(roomId)) die("--roomId must be a 6-digit code (e.g. 123456) or PX-123456.");
const name = flag(args, "name");
const out = flag(args, "out") ?? path.join("rooms", `${roomId}.json`);
const outExists = await exists(out);
const renew = args.flags.has("renew");
const prev = outExists ? await readJson(out) : null;

if (!name && !outExists) die("--name is required when creating a new room manifest.");

// ---------- owner signing key (SECRET — local only) ----------
const keyFile = flag(args, "key") ?? path.join("keys", `${roomId}.owner.pkcs8.b64`);

/** ECDSA public raw point (04 || x || y) recovered from a PKCS8 private key. */
async function publicRawFromPrivate(priv: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const dec = (s: string) => fromB64url(s);
  const x = dec(jwk.x!), y = dec(jwk.y!);
  const out = new Uint8Array(1 + x.length + y.length);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 1 + x.length);
  return out;
}

let priv: CryptoKey;
let pubRaw: Uint8Array<ArrayBuffer>;
if (await exists(keyFile)) {
  priv = await importSigningPrivateKeyPkcs8(fromB64url((await fs.readFile(keyFile, "utf8")).trim()));
  pubRaw = await publicRawFromPrivate(priv);
} else {
  if (outExists && !renew) die(`Refusing to overwrite ${out} without --key: a room manifest is owner-signed, not re-creatable by anyone.`);
  const pair = await generateSigningKey();
  priv = pair.privateKey;
  pubRaw = await exportSigningPublicKeyRaw(pair.publicKey);
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  await fs.writeFile(keyFile, `${b64url(await exportSigningPrivateKeyPkcs8(priv))}\n`, "utf8");
  console.log(`[keys] new owner signing key saved to ${keyFile} — keep it secret, keep it local. It is the ONLY way to re-register this room.`);
}

const ownerId = await ownerFingerprint(pubRaw);

// ---------- host commitment (anchors WebRTC identity verification) ----------
const idKeyFile = flag(args, "identity-key");
let hostCommitment = flag(args, "host-commitment") ?? (prev as { host?: { commitment?: string } } | null)?.host?.commitment ?? "";
if (!hostCommitment && idKeyFile) {
  // Recover the ECDH identity's public raw bytes from its PKCS8 private key:
  // export JWK (has x/y), rebuild the public JWK, import it, export "raw".
  const ecdhPriv = await crypto.subtle.importKey("pkcs8", fromB64url((await fs.readFile(idKeyFile, "utf8")).trim()), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ecdhPub = await crypto.subtle.importKey("jwk", (await crypto.subtle.exportKey("jwk", ecdhPriv)) as JsonWebKey, { name: "ECDH", namedCurve: "P-256" }, true, []);
  // The JWK round-trip through importKey requires x/y present on EC keys; passing
  // the full private JWK (with d) imports it as the PUBLIC key, which is what we want.
  hostCommitment = await commitmentOf(new Uint8Array(await crypto.subtle.exportKey("raw", ecdhPub)));
}
if (!hostCommitment) {
  die("The manifest needs the host's ECDH identity commitment (--host-commitment <hex>, shown in the app) — it is what joiners verify the WebRTC peer against.");
}

// ---------- assemble + sign ----------
const now = Date.now();
const ttlDays = Math.max(1, Math.min(30, Number(flag(args, "ttl-days") ?? 30)));
const createdAt = typeof (prev as { createdAt?: number } | null)?.createdAt === "number" ? (prev as { createdAt: number }).createdAt : now;

const coOwnerPolicy = flag(args, "policy") === "co-owner" ? "co-owner" : "owner-only";
const manifest = await signManifest(
  {
    roomId,
    name: name ?? (prev as { name?: string } | null)?.name ?? roomId,
    desc: flag(args, "desc") ?? (prev as { desc?: string } | null)?.desc ?? "",
    type: (flag(args, "type") as "public" | "private") ?? "public",
    category: flag(args, "category") ?? (prev as { category?: string } | null)?.category ?? "General Chat",
    region: flag(args, "region") ?? (prev as { region?: string } | null)?.region ?? "",
    subRegion: flag(args, "subRegion") ?? (prev as { subRegion?: string } | null)?.subRegion ?? "",
    city: flag(args, "city") ?? (prev as { city?: string } | null)?.city ?? "",
    languages: splitList(flag(args, "languages")).length ? splitList(flag(args, "languages")) : ((prev as { languages?: string[] } | null)?.languages ?? ["English"]),
    owner: { id: ownerId, signingKey: b64url(pubRaw) },
    host: { commitment: hostCommitment },
    coordinator: { urls: [...flags(args, "coordinator").flatMap(splitList)] },
    capabilities: {
      media: true,
      stickers: true,
      history: false,
      slowMode: args.flags.has("slow-mode"),
      approval: args.flags.has("approval"),
    },
    invitation: { method: args.flags.has("code") ? "code" : "open" },
    policy: { recovery: coOwnerPolicy, coOwners: flags(args, "co-owner").flatMap(splitList) },
    createdAt,
    updatedAt: now,
    expiresAt: now + ttlDays * 24 * 60 * 60_000,
  },
  priv,
);

// ---------- self-verify before publishing anything ----------
const check = await verifyManifest(JSON.parse(JSON.stringify(manifest)));
if (!check.ok) die(`BUG: generated manifest failed self-verification: ${check.reason}`);
if (!(await verifyOwnerFingerprint(manifest))) die("BUG: owner fingerprint does not match the signing key.");

await writeJson(out, manifest);
console.log(`[manifest] signed manifest written to ${out}`);
console.log(`           room ${roomId} — "${manifest.name}" (owner ${ownerId})`);
console.log(`           sections: ${manifestSections(manifest).join(", ")}`);
console.log(`           expires: ${new Date(manifest.expiresAt).toISOString()} — republish before then to keep it discoverable.`);
