import "server-only";

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { previousSecretsKeys, secretsKey } from "@/lib/core/config";

/**
 * Encryption of documents in the local vault: AES-256-GCM, a key derived with HKDF from KONTROL_SECRETS_KEY, the tenant and document
 * bound as additional authenticated data (a file copied to another tenant or document fails to open).
 *
 * File layout: "KVLT1" | key id (8 hex characters, a fingerprint of the key that sealed it) | IV (12) | tag (16) | ciphertext.
 * The key id lets the right key be chosen after a rotation. Files written before encryption existed carry no header; they are read as
 * plaintext (their hash is still verified) and are encrypted by the next key rotation.
 */
const MAGIC = Buffer.from("KVLT1");
const ID_LENGTH = 8;
const HEADER = MAGIC.length + ID_LENGTH + 12 + 16;

const fingerprint = (material: string) => createHash("sha256").update(material).digest("hex").slice(0, ID_LENGTH);
const derive = (material: string) => Buffer.from(hkdfSync("sha256", material, "kontrol-vault", "v1", 32));

export function sealBytes(plain: Buffer, aad: string) {
  const material = secretsKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(material), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from(fingerprint(material)), iv, cipher.getAuthTag(), body]);
}

export type Opened = {
  bytes: Buffer;
  /** Written before encryption existed. */ legacy: boolean;
  /** Sealed with a key other than the current one. */ needsRekey: boolean;
};

export function openBytes(file: Buffer, aad: string): Opened {
  if (file.length < MAGIC.length || !file.subarray(0, MAGIC.length).equals(MAGIC)) return { bytes: file, legacy: true, needsRekey: true };
  if (file.length < HEADER) throw new Error("Vault file is truncated");
  const id = file.subarray(MAGIC.length, MAGIC.length + ID_LENGTH).toString();
  const iv = file.subarray(MAGIC.length + ID_LENGTH, MAGIC.length + ID_LENGTH + 12);
  const tag = file.subarray(MAGIC.length + ID_LENGTH + 12, HEADER);
  const candidates = [secretsKey(), ...previousSecretsKeys()].filter((material) => fingerprint(material) === id);
  if (!candidates.length)
    throw new Error(`Vault file was sealed with a key (${id}) that is not configured: add it to KONTROL_SECRETS_KEY_PREVIOUS`);
  const decipher = createDecipheriv("aes-256-gcm", derive(candidates[0]), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return {
      bytes: Buffer.concat([decipher.update(file.subarray(HEADER)), decipher.final()]),
      legacy: false,
      needsRekey: id !== fingerprint(secretsKey()),
    };
  } catch {
    throw new Error("Vault file failed authentication: it was altered, or moved to another tenant or document");
  }
}
