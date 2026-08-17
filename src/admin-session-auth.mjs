import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const passwordHashPrefix = "scrypt";
const passwordSaltBytes = 16;
const passwordKeyBytes = 32;
const scryptParameters = Object.freeze({ N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const minimumPasswordCharacters = 12;
const maximumPasswordCharacters = 256;
const maximumPasswordBytes = 1_024;
const maximumIdentifiers = 5;
const maximumSessions = 20;
const loginWindowMs = 15 * 60 * 1_000;
const maximumLoginFailures = 5;

export const adminSessionCookieName = "foursday_session";

function equalValue(actual, expected) {
  const left = Buffer.from(String(actual ?? ""));
  const right = Buffer.from(String(expected ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeAdminLoginIdentifier(value) {
  const identifier = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  if (
    identifier.length < 3 ||
    identifier.length > 254 ||
    /[\p{Cc}\p{Z}]/u.test(identifier) ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._@+-]*$/u.test(identifier)
  ) {
    throw new Error("Admin login identifier must be a username or email-like value");
  }
  return identifier;
}

export function normalizeAdminLoginIdentifiers(values) {
  const raw = Array.isArray(values) ? values : String(values ?? "").split(",");
  const identifiers = [...new Set(raw.filter((value) => String(value).trim()).map(
    normalizeAdminLoginIdentifier,
  ))];
  if (identifiers.length < 1 || identifiers.length > maximumIdentifiers) {
    throw new Error(`Admin login identifiers must contain 1-${maximumIdentifiers} values`);
  }
  return identifiers;
}

export function validateAdminPassword(password, { identifiers = [] } = {}) {
  const value = String(password ?? "");
  if (
    value.length < minimumPasswordCharacters ||
    value.length > maximumPasswordCharacters ||
    Buffer.byteLength(value) > maximumPasswordBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(
      `Admin password must contain ${minimumPasswordCharacters}-${maximumPasswordCharacters} characters without line breaks`,
    );
  }
  const normalizedPassword = value.normalize("NFKC").toLowerCase();
  if (identifiers.some((identifier) => normalizedPassword.includes(identifier))) {
    throw new Error("Admin password must not contain a login identifier");
  }
  return value;
}

function passwordHashParts(value) {
  const [prefix, rawN, rawR, rawP, saltValue, keyValue, extra] = String(value ?? "").split("$");
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  let salt;
  let key;
  try {
    salt = Buffer.from(saltValue ?? "", "base64url");
    key = Buffer.from(keyValue ?? "", "base64url");
  } catch {
    throw new Error("Admin password hash is invalid");
  }
  if (
    extra != null ||
    prefix !== passwordHashPrefix ||
    N !== scryptParameters.N ||
    r !== scryptParameters.r ||
    p !== scryptParameters.p ||
    salt.length !== passwordSaltBytes ||
    key.length !== passwordKeyBytes ||
    salt.toString("base64url") !== saltValue ||
    key.toString("base64url") !== keyValue
  ) {
    throw new Error("Admin password hash is invalid");
  }
  return { N, r, p, salt, key };
}

export async function createAdminPasswordHash(password, {
  identifiers = [],
  salt = randomBytes(passwordSaltBytes),
} = {}) {
  const normalizedIdentifiers = normalizeAdminLoginIdentifiers(identifiers);
  const value = validateAdminPassword(password, { identifiers: normalizedIdentifiers });
  if (!Buffer.isBuffer(salt) || salt.length !== passwordSaltBytes) {
    throw new Error(`Admin password salt must contain ${passwordSaltBytes} bytes`);
  }
  const key = Buffer.from(await scrypt(value, salt, passwordKeyBytes, scryptParameters));
  return [
    passwordHashPrefix,
    scryptParameters.N,
    scryptParameters.r,
    scryptParameters.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyAdminPassword(password, passwordHash) {
  const { N, r, p, salt, key } = passwordHashParts(passwordHash);
  const value = String(password ?? "");
  if (Buffer.byteLength(value) > maximumPasswordBytes) return false;
  const actual = Buffer.from(await scrypt(value, salt, key.length, {
    N,
    r,
    p,
    maxmem: scryptParameters.maxmem,
  }));
  return timingSafeEqual(actual, key);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sessionCookieValue(cookieHeader) {
  const matches = String(cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${adminSessionCookieName}=`))
    .map((part) => part.slice(adminSessionCookieName.length + 1));
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(matches[0])) return null;
  return matches[0];
}

export function createAdminSessionManager({
  identifiers = [],
  passwordHash = null,
  sessionTtlMs = 8 * 60 * 60 * 1_000,
  now = () => Date.now(),
} = {}) {
  const configured = Boolean(
    (Array.isArray(identifiers) ? identifiers.length : String(identifiers ?? "").trim()) ||
    String(passwordHash ?? "").trim(),
  );
  const normalizedIdentifiers = configured ? normalizeAdminLoginIdentifiers(identifiers) : [];
  const normalizedHash = configured ? String(passwordHash ?? "").trim() : null;
  if (configured) passwordHashParts(normalizedHash);
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 300_000 || sessionTtlMs > 86_400_000) {
    throw new Error("Admin session TTL must be between 5 minutes and 24 hours");
  }
  const sessions = new Map();
  let loginFailures = [];

  function purgeExpired(at = now()) {
    loginFailures = loginFailures.filter((timestamp) => timestamp > at - loginWindowMs);
    for (const [key, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(key);
    }
  }

  function sessionForCookie(cookieHeader, at = now()) {
    purgeExpired(at);
    const token = sessionCookieValue(cookieHeader);
    if (!token) return null;
    const session = sessions.get(sha256(token));
    return session?.expiresAt > at ? session : null;
  }

  return {
    configured,
    identifiers: [...normalizedIdentifiers],
    async login({ identifier, password } = {}) {
      const at = now();
      purgeExpired(at);
      if (!configured) return { status: "unavailable" };
      if (loginFailures.length >= maximumLoginFailures) {
        return {
          status: "rate_limited",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((loginFailures[0] + loginWindowMs - at) / 1_000),
          ),
        };
      }
      let normalizedIdentifier = null;
      try {
        normalizedIdentifier = normalizeAdminLoginIdentifier(identifier);
      } catch {
        // Run the same password verifier below before returning a generic failure.
      }
      const passwordMatches = await verifyAdminPassword(password, normalizedHash);
      const identifierMatches = normalizedIdentifiers.includes(normalizedIdentifier);
      if (!passwordMatches || !identifierMatches) {
        loginFailures.push(at);
        return { status: "invalid" };
      }
      loginFailures = [];
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const expiresAt = at + sessionTtlMs;
      if (sessions.size >= maximumSessions) {
        const oldest = [...sessions.entries()].sort(
          ([, left], [, right]) => left.createdAt - right.createdAt,
        )[0]?.[0];
        if (oldest) sessions.delete(oldest);
      }
      sessions.set(sha256(token), {
        identifier: normalizedIdentifier,
        csrfToken,
        createdAt: at,
        expiresAt,
      });
      return {
        status: "authenticated",
        identifier: normalizedIdentifier,
        token,
        csrfToken,
        expiresAt,
      };
    },
    authenticate(cookieHeader) {
      return sessionForCookie(cookieHeader);
    },
    csrfAuthorized(session, token) {
      return Boolean(session && equalValue(token, session.csrfToken));
    },
    revoke(cookieHeader) {
      const token = sessionCookieValue(cookieHeader);
      if (!token) return false;
      return sessions.delete(sha256(token));
    },
    clear() {
      sessions.clear();
      loginFailures = [];
    },
  };
}

export function adminSessionCookie(token, ttlMs) {
  const maxAge = Math.floor(ttlMs / 1_000);
  return `${adminSessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearAdminSessionCookie() {
  return `${adminSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
