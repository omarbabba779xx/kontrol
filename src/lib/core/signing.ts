import "server-only";

import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { isProduction, signingSecret } from "@/lib/core/config";

/**
 * Asymmetric signatures. Anyone holding the public key can verify a decision, a report or an audit anchor; only the holder of the
 * private key can produce one. Two custodies:
 *
 *   kms    `KONTROL_SIGNING_KMS_KEY_ID` names an AWS KMS key (ECC_NIST_P256, sign/verify). The private key never leaves the KMS and
 *          never enters this process: the application can ask for a signature, the people who run the database or the host cannot
 *          take the key. Each signature is a KMS API call, attributable in CloudTrail. Signatures are `kms-ecdsa-p256:`.
 *   local  `KONTROL_SIGNING_KEY` is an Ed25519 private key (PKCS#8 PEM, or the same PEM base64-encoded) held by the process.
 *          Signatures are `ed25519:`. Whoever can read the process environment can sign.
 *
 * Production needs one of the two. Development derives a stable local key from the signing secret so tests and local runs are
 * reproducible. Signatures made before any of this existed are hex HMACs; they stay verifiable, and nothing new is made that way.
 */
const ED25519 = "ed25519:";
const KMS_ECDSA = "kms-ecdsa-p256:";
const PKCS8_SEED_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

type KmsLike = { send(command: unknown): Promise<unknown> };
let kmsClient: KmsLike | null = null;
/** Test seam: replaces the KMS client. Never called by application code. */
export function setKmsClient(client: KmsLike | null) {
  kmsClient = client;
  kmsPublicKey = null;
}

const kmsKeyId = () => process.env.KONTROL_SIGNING_KMS_KEY_ID?.trim() || null;
async function kms() {
  if (kmsClient) return kmsClient;
  const { KMSClient } = await import("@aws-sdk/client-kms");
  kmsClient = new KMSClient({});
  return kmsClient;
}

let local: { source: string; privateKey: KeyObject; publicKey: KeyObject } | null = null;

function loadLocal() {
  const configured = process.env.KONTROL_SIGNING_KEY ?? "";
  if (local && local.source === configured + signingSecretSafe()) return local;
  let privateKey: KeyObject;
  if (configured) {
    const pem = configured.includes("BEGIN") ? configured : Buffer.from(configured, "base64").toString("utf8");
    privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("KONTROL_SIGNING_KEY must be an Ed25519 private key");
  } else {
    if (isProduction())
      throw new Error("A signing key is required in production: set KONTROL_SIGNING_KMS_KEY_ID (an AWS KMS key) or KONTROL_SIGNING_KEY (an Ed25519 private key; `npm run keys:signing`)");
    warnDevelopmentKey();
    const seed = createHash("sha256").update(`kontrol-dev-signing-key:${signingSecret()}`).digest();
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_SEED_HEADER, seed]), format: "der", type: "pkcs8" });
  }
  local = { source: configured + signingSecretSafe(), privateKey, publicKey: createPublicKey(privateKey) };
  return local;
}

let warned = false;
function warnDevelopmentKey() {
  if (warned || process.env.NODE_ENV === "test") return;
  warned = true;
  console.warn(
    "signing: no signing key is configured, so signatures use a key derived from the development secret. Anyone who knows that secret can forge them. Set KONTROL_SIGNING_KMS_KEY_ID or KONTROL_SIGNING_KEY on every environment that is not a developer machine, staging included.",
  );
}

/** Where the signing key lives. Shown on the health and admin pages. */
export const signingKeyMode = () => (kmsKeyId() ? ("kms" as const) : process.env.KONTROL_SIGNING_KEY ? ("configured" as const) : ("development-derived" as const));

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

let kmsPublicKey: { keyId: string; key: KeyObject } | null = null;
async function loadKmsPublicKey(keyId: string) {
  if (kmsPublicKey && kmsPublicKey.keyId === keyId) return kmsPublicKey.key;
  const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
  const response = (await (await kms()).send(new GetPublicKeyCommand({ KeyId: keyId }))) as { PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string };
  if (!response.PublicKey) throw new Error("The KMS key has no public key to export");
  if (response.KeySpec !== "ECC_NIST_P256" || response.KeyUsage !== "SIGN_VERIFY") throw new Error("KONTROL_SIGNING_KMS_KEY_ID must be an ECC_NIST_P256 key with usage SIGN_VERIFY");
  const key = createPublicKey({ key: Buffer.from(response.PublicKey), format: "der", type: "spki" });
  kmsPublicKey = { keyId, key };
  return key;
}

/** Public half of the signing key, for third parties; the fingerprint identifies it in published signatures and anchors. */
export async function publicSigningKey() {
  const keyId = kmsKeyId();
  const key = keyId ? await loadKmsPublicKey(keyId) : loadLocal().publicKey;
  const der = key.export({ type: "spki", format: "der" });
  return {
    algorithm: keyId ? "ECDSA P-256 with SHA-256" : "Ed25519",
    custody: signingKeyMode(),
    publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(),
    fingerprint: createHash("sha256").update(der).digest("hex"),
  };
}

export async function signBytes(message: string) {
  const keyId = kmsKeyId();
  if (!keyId) return `${ED25519}${sign(null, Buffer.from(message), loadLocal().privateKey).toString("base64url")}`;
  await loadKmsPublicKey(keyId); // refuses a key of the wrong kind before anything is signed with it
  const { SignCommand } = await import("@aws-sdk/client-kms");
  // The KMS signs a digest, so a message of any size costs one small call.
  const response = (await (await kms()).send(new SignCommand({ KeyId: keyId, Message: createHash("sha256").update(message).digest(), MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }))) as { Signature?: Uint8Array };
  if (!response.Signature) throw new Error("The KMS returned no signature");
  return `${KMS_ECDSA}${Buffer.from(response.Signature).toString("base64url")}`;
}

/** Whether a string is one of the asymmetric signature forms (as opposed to the earlier HMAC). */
export const isAsymmetric = (signature: string) => signature.startsWith(ED25519) || signature.startsWith(KMS_ECDSA);

/**
 * Verifies against the given public key (PEM), as a third party would, or against this installation's own key when none is given.
 * Verification is local in both custodies: it needs the public key only, never a call that could be refused or billed.
 */
export async function verifyBytes(message: string, signature: string, publicKeyPem?: string) {
  try {
    if (signature.startsWith(ED25519)) {
      const key = publicKeyPem ? createPublicKey(publicKeyPem) : loadLocal().publicKey;
      return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(message), key, Buffer.from(signature.slice(ED25519.length), "base64url"));
    }
    if (signature.startsWith(KMS_ECDSA)) {
      const keyId = kmsKeyId();
      if (!publicKeyPem && !keyId) return false;
      const key = publicKeyPem ? createPublicKey(publicKeyPem) : await loadKmsPublicKey(keyId!);
      return key.asymmetricKeyType === "ec" && verify("sha256", Buffer.from(message), { key, dsaEncoding: "der" }, Buffer.from(signature.slice(KMS_ECDSA.length), "base64url"));
    }
    return false;
  } catch {
    return false;
  }
}

/** The pre-asymmetric form, kept only so signatures that already exist stay verifiable. */
export const legacyHmac = (message: string) => createHmac("sha256", signingSecret()).update(message).digest("hex");
