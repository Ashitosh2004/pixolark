/** Key-material helpers shared by the owner tools. Secrets stay on disk locally. */
import { fromB64url } from "../../src/lib/pixel/bytes";

/** ECDSA/ECDH public raw point (04 || x || y) recovered from a PKCS8 private key. */
export async function publicRawFromPrivate(priv: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const x = fromB64url(jwk.x!);
  const y = fromB64url(jwk.y!);
  const out = new Uint8Array(1 + x.length + y.length);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 1 + x.length);
  return out;
}

/** ECDH identity public raw bytes from a PKCS8 private key (via public JWK). */
export async function ecdhPublicRawFromPrivate(priv: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const pub = await crypto.subtle.importKey("jwk", { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! } as JsonWebKey, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return new Uint8Array(await crypto.subtle.exportKey("raw", pub));
}
