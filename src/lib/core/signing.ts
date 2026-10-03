import "server-only";

import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { isProduction, signingSecret } from "@/lib/core/config";

/**
 * Asymmetric signatures (Ed25519). Anyone holding the public key can verify a decision, a report or an audit anchor; only the holder of
 * the private key can produce one. The private key is `KONTROL_SIGNING_KEY` (PKCS#8 PEM, or the same PEM base64-encoded), required in
 * production. Development derives a stable key from the signing secret so tests and local runs are reproducible.
 *
 * Signatures made before this existed are hex HMACs; they are still accepted by `verifySignature`, but nothing new is made that way.
 */
const PREFIX = "ed25519:";
const PKCS8_SEED_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

let cached: { source: string; privateKey: KeyObject; publicKey: KeyObject } | null = null;

function load() {
  const configured = process.env.KONTROL_SIGNING_KEY ?? "";
  if (cached && cached.source === configured + signingSecretSafe()) return cached;
  let privateKey: KeyObject;
  if (configured) {
    const pem = configured.includes("BEGIN") ? configured : Buffer.from(configured, "base64").toString("utf8");
    privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("KONTROL_SIGNING_KEY must be an Ed25519 private key");
  } else {
    if (isProduction())
      throw new Error("KONTROL_SIGNING_KEY is required in production (an Ed25519 private key; generate one with `npm run keys:signing`)");
    warnDevelopmentKey();
    const seed = createHash("sha256").update(`kontrol-dev-signing-key:${signingSecret()}`).digest();
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_SEED_HEADER, seed]), format: "der", type: "pkcs8" });
  }
  cached = { source: configured + signingSecretSafe(), privateKey, publicKey: createPublicKey(privateKey) };
  return cached;
}

let warned = false;
function warnDevelopmentKey() {
  if (warned || process.env.NODE_ENV === "test") return;
  warned = true;
  console.warn(
    "signing: KONTROL_SIGNING_KEY is not set, so signatures use a key derived from the development secret. Anyone who knows that secret can forge them. Set KONTROL_SIGNING_KEY on every environment that is not a developer machine, staging included.",
  );
}

/** Whether signatures come from a configured key or from the development fallback. Shown on the health and admin pages. */
export const signingKeyMode = () => (process.env.KONTROL_SIGNING_KEY ? ("configured" as const) : ("development-derived" as const));

const signingSecretSafe = () => {
  try {
    return signingSecret();
  } catch {
    return "";
  }
};

export const generateSigningKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

/** Public half of the signing key, for third parties; the fingerprint identifies it in published signatures and anchors. */
export function publicSigningKey() {
  const pem = load().publicKey.export({ type: "spki", format: "pem" }).toString();
  const der = load().publicKey.export({ type: "spki", format: "der" });
  return { algorithm: "Ed25519", publicKeyPem: pem, fingerprint: createHash("sha256").update(der).digest("hex") };
}

export const signBytes = (message: string) => `${PREFIX}${sign(null, Buffer.from(message), load().privateKey).toString("base64url")}`;

/** Verifies against the given public key (PEM). Pass none to use this instance's own key. */
export function verifyBytes(message: string, signature: string, publicKeyPem?: string) {
  if (!signature.startsWith(PREFIX)) return false;
  try {
    const key = publicKeyPem ? createPublicKey(publicKeyPem) : load().publicKey;
    return verify(null, Buffer.from(message), key, Buffer.from(signature.slice(PREFIX.length), "base64url"));
  } catch {
    return false;
  }
}

/** The pre-asymmetric form, kept only so signatures that already exist stay verifiable. */
export const legacyHmac = (message: string) => createHmac("sha256", signingSecret()).update(message).digest("hex");
