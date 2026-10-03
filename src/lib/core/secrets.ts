import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { previousSecretsKeys, secretsKey } from "@/lib/core/config";

/**
 * Encryption at rest for connector credentials: AES-256-GCM with a key derived (HKDF) from KONTROL_SECRETS_KEY.
 * The tenant and credential kind are bound as additional authenticated data, so a ciphertext copied to another
 * tenant or another connector fails to decrypt instead of being silently accepted.
 */
export const KEY_VERSION = 1;

export type SealedBox = { ciphertext: string; iv: string; tag: string; keyVersion: number };

const derive = (material: string) => Buffer.from(hkdfSync("sha256", material, "kontrol-credentials", `v${KEY_VERSION}`, 32));
function key() {
  return derive(secretsKey());
}

export function seal(plaintext: string, aad: string): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), keyVersion: KEY_VERSION };
}

function openWith(material: Buffer, box: { ciphertext: string; iv: string; tag: string }, aad: string) {
  const decipher = createDecipheriv("aes-256-gcm", material, Buffer.from(box.iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** Tries the current key, then each previous key: the authentication tag makes a wrong key fail rather than return garbage. */
export function open(box: { ciphertext: string; iv: string; tag: string }, aad: string): string {
  let failure: unknown;
  for (const material of [key(), ...previousSecretsKeys().map(derive)]) {
    try { return openWith(material, box, aad); } catch (error) { failure = error; }
  }
  throw failure;
}

/** True when the box opens with the current key, false when it needs a previous one (and should be re-sealed). */
export function sealedWithCurrentKey(box: { ciphertext: string; iv: string; tag: string }, aad: string) {
  try { openWith(key(), box, aad); return true; } catch { return false; }
}
