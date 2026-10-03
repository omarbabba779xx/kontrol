import { generateKeyPairSync } from "node:crypto";

/**
 * Prints a new Ed25519 signing key. Keep the private key in your secret store (KONTROL_SIGNING_KEY); publish the public key, which is
 * also served at /api/signing-key, so that anyone can verify decisions, reports and audit anchors without trusting the server.
 */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
console.log("KONTROL_SIGNING_KEY (single line, base64 of the PEM):");
console.log(Buffer.from(privatePem).toString("base64"));
console.log("\nPublic key (publish this):");
console.log(publicKey.export({ type: "spki", format: "pem" }).toString());
