import "server-only";

import { timingSafeEqual } from "node:crypto";

const DEV_AUTH_SECRET = "local-development-secret-change-me";
const DEV_SIGNING_SECRET = "local-signing-key-change-me";
const PLACEHOLDER = /^(replace-with|change-me|local-)/i;
const MIN_SECRET_LENGTH = 32;

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function isDemoMode() {
  return process.env.KONTROL_AUTH_MODE === "demo";
}

function readSecret(name: string, fallback: string) {
  const value = process.env[name];
  if (!isProduction()) return value || fallback;
  if (!value || value.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(value)) {
    throw new Error(`${name} must be set to a unique secret of at least ${MIN_SECRET_LENGTH} characters in production`);
  }
  return value;
}

/** Secret used to sign session tokens. Fails closed in production when missing or weak. */
export function authSecret() {
  return readSecret("KONTROL_AUTH_SECRET", DEV_AUTH_SECRET);
}

/** Secret used to sign decision manifests. Must differ from the session secret in production. */
export function signingSecret() {
  const value = readSecret("KONTROL_SIGNING_SECRET", DEV_SIGNING_SECRET);
  if (isProduction() && value === process.env.KONTROL_AUTH_SECRET) {
    throw new Error("KONTROL_SIGNING_SECRET must differ from KONTROL_AUTH_SECRET");
  }
  return value;
}

/** Key that protects connector credentials at rest. Required in production; a development fallback is used otherwise. */
export function secretsKey() {
  return readSecret("KONTROL_SECRETS_KEY", "local-secrets-key-change-me-0123456789");
}

/**
 * Earlier values of KONTROL_SECRETS_KEY, comma separated. Data sealed under them stays readable until it is re-sealed with the
 * current key (see key-rotation.ts), so a key can be rotated without losing credentials or documents.
 */
export function previousSecretsKeys() {
  const keys = (process.env.KONTROL_SECRETS_KEY_PREVIOUS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (isProduction()) for (const key of keys) if (key.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(key)) throw new Error(`KONTROL_SECRETS_KEY_PREVIOUS entries must be unique secrets of at least ${MIN_SECRET_LENGTH} characters`);
  return keys;
}

/** Demo authentication is an evaluation convenience and is never honoured in production. */
export function demoAuthAllowed() {
  return !isProduction() || (isDemoMode() && process.env.KONTROL_ALLOW_DEMO_IN_PRODUCTION === "true");
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
