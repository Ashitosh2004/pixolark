/**
 * Directory seeder — creates the demo room directory used for local
 * development and testing.
 *
 * It generates a REAL local seed-owner identity (ECDH identity + ECDSA signing
 * key, both extractable so they can later be imported into the app), signs a
 * spread of rooms across global/country/state/city/language sections, and runs
 * the directory publisher. Keys live in tools/seeds/ (gitignored — they are
 * secrets); the signed manifests in rooms/ are public and committed.
 *
 *   bun tools/seed-directory.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { b64url, fromB64url } from "../src/lib/pixel/bytes";
import { commitmentOf } from "../src/lib/pixel/crypto";
import {
  exportSigningPrivateKeyPkcs8,
  generateSigningKey,
  importSigningPrivateKeyPkcs8,
  ownerFingerprint,
  signManifest,
} from "../src/lib/pixel/manifest";
import { ecdhPublicRawFromPrivate, publicRawFromPrivate } from "./lib/keys";
import { exists, writeJson } from "./lib/cli";
import { buildDirectory } from "./directory-publisher/lib";

const SEEDS_DIR = "tools/seeds";
const IDENTITY_FILE = path.join(SEEDS_DIR, "seed-owner.json");
const ROOMS_DIR = "rooms";
const OUT_DIR = "room-directory";

interface SeedIdentity {
  createdAt: number;
  /** ECDH identity (the "host" anchor) — pkcs8, base64url. SECRET. */
  ecdhPkcs8: string;
  /** ECDSA signing key for manifests — pkcs8, base64url. SECRET. */
  signPkcs8: string;
}

async function loadSeedIdentity(): Promise<{ ecdhPubRaw: Uint8Array<ArrayBuffer>; signPriv: CryptoKey }> {
  if (await exists(IDENTITY_FILE)) {
    const s = JSON.parse(await fs.readFile(IDENTITY_FILE, "utf8")) as SeedIdentity;
    const ecdhPriv = await crypto.subtle.importKey("pkcs8", fromB64url(s.ecdhPkcs8), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const signPriv = await importSigningPrivateKeyPkcs8(fromB64url(s.signPkcs8));
    return { ecdhPubRaw: await ecdhPublicRawFromPrivate(ecdhPriv), signPriv };
  }
  // Fresh seed identity — extractable on purpose so it can be imported into
  // the app later and honestly act as the host for these demo rooms.
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const sign = await generateSigningKey();
  const s: SeedIdentity = {
    createdAt: Date.now(),
    ecdhPkcs8: b64url(await crypto.subtle.exportKey("pkcs8", ecdh.privateKey)),
    signPkcs8: b64url(await exportSigningPrivateKeyPkcs8(sign.privateKey)),
  };
  await fs.mkdir(SEEDS_DIR, { recursive: true });
  await fs.writeFile(IDENTITY_FILE, `${JSON.stringify(s, null, 2)}\n`, "utf8");
  console.log(`[seed] seed-owner identity created at ${IDENTITY_FILE} (gitignored — keep it, it is these rooms' owner)`);
  return {
    ecdhPubRaw: new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey)),
    signPriv: sign.privateKey,
  };
}

interface SeedRoom {
  name: string;
  desc: string;
  category: string;
  region?: string;
  subRegion?: string;
  city?: string;
  languages: string[];
}

const SEED_ROOMS: SeedRoom[] = [
  { name: "Global Lounge", desc: "The main gathering space", category: "General Chat", languages: ["English"] },
  { name: "Tech Talk", desc: "Gadgets, code and future stuff", category: "Technology", languages: ["English"] },
  { name: "Pixel Arcade", desc: "Gaming nights, pixel style", category: "Gaming", languages: ["English"] },
  { name: "Anime Corner", desc: "Anime and manga", category: "Anime", languages: ["English", "Hindi"] },
  { name: "Now Playing", desc: "Music sharing", category: "Music", languages: ["English"] },
  { name: "Screening Room", desc: "Movies and shows", category: "Movies", languages: ["English"] },
  { name: "Study Hall", desc: "Learn together", category: "Education", languages: ["English", "Hindi"] },
  { name: "Meme Gallery", desc: "The finest pixel memes", category: "Memes", languages: ["English"] },
  { name: "Snapshot", desc: "Photography", category: "Photography", languages: ["English"] },
  { name: "Wander", desc: "Travel stories", category: "Travel", languages: ["English"] },
  { name: "India Lounge", desc: "Rooms from across India", category: "General Chat", region: "India", languages: ["English", "Hindi"] },
  { name: "Maharashtra Adda", desc: "Maharashtra regional lounge", category: "General Chat", region: "India", subRegion: "Maharashtra", languages: ["Marathi", "Hindi", "English"] },
  { name: "Kolhapur Pixels", desc: "Kolhapur city room", category: "General Chat", region: "India", subRegion: "Maharashtra", city: "Kolhapur", languages: ["Marathi"] },
  { name: "Pune Pixels", desc: "Pune city room", category: "General Chat", region: "India", subRegion: "Maharashtra", city: "Pune", languages: ["Marathi", "English"] },
  { name: "Mumbai Pixels", desc: "Mumbai city room", category: "General Chat", region: "India", subRegion: "Maharashtra", city: "Mumbai", languages: ["Marathi", "Hindi"] },
  { name: "Belgaum Beats", desc: "Belgaum city room", category: "General Chat", region: "India", subRegion: "Karnataka", city: "Belgaum", languages: ["Kannada", "Marathi"] },
  { name: "Bengaluru Pixels", desc: "Bengaluru city room", category: "Technology", region: "India", subRegion: "Karnataka", city: "Bengaluru", languages: ["Kannada", "English"] },
  { name: "Karnataka Kone", desc: "Karnataka regional lounge", category: "General Chat", region: "India", subRegion: "Karnataka", languages: ["Kannada", "English"] },
];

const { ecdhPubRaw, signPriv } = await loadSeedIdentity();
const hostCommitment = await commitmentOf(ecdhPubRaw);
const ownerId = await ownerFingerprint(await publicRawFromPrivate(signPriv));
const signingKeyB64 = b64url(await publicRawFromPrivate(signPriv));

let seq = 421000;
const now = Date.now();
const TTL = 30 * 24 * 60 * 60_000;
await fs.mkdir(ROOMS_DIR, { recursive: true });

for (const r of SEED_ROOMS) {
  seq += Math.floor(Math.random() * 900) + 1;
  const roomId = `${seq}`;
  const manifest = await signManifest(
    {
      roomId,
      name: r.name,
      desc: r.desc,
      type: "public",
      category: r.category,
      region: r.region ?? "",
      subRegion: r.subRegion ?? "",
      city: r.city ?? "",
      languages: r.languages,
      owner: { id: ownerId, signingKey: signingKeyB64 },
      host: { commitment: hostCommitment },
      coordinator: { urls: [] },
      capabilities: { media: true, stickers: true, history: false, slowMode: false, approval: false },
      invitation: { method: "open" },
      policy: { recovery: "owner-only", coOwners: [] },
      createdAt: now,
      updatedAt: now,
      expiresAt: now + TTL,
    },
    signPriv,
  );
  await fs.writeFile(path.join(ROOMS_DIR, `${roomId}.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
console.log(`[seed] ${SEED_ROOMS.length} signed room manifest(s) written to ${ROOMS_DIR}/`);

const report = await buildDirectory(ROOMS_DIR, []);
for (const f of report.files) {
  await writeJson(path.join(OUT_DIR, `${f.section}.json`), f.data);
}
await writeJson(path.join(OUT_DIR, "index.json"), report.index);
console.log(`[seed] directory built: ${report.rooms.length} room(s) in ${report.files.length} section(s) → ${OUT_DIR}/`);
