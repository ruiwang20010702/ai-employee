import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const prefix = "enc:v1:";

function decodeKey(value) {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("AI_EMPLOYEE_DATA_KEY must be a base64 encoded 32-byte key");
  }
  return key;
}

export class DataCipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error("DataCipher requires a 32-byte key");
    }
    this.key = key;
  }

  static async create({ encodedKey, keyPath, ephemeral = false }) {
    if (encodedKey) return new DataCipher(decodeKey(encodedKey));
    if (ephemeral) return new DataCipher(randomBytes(32));
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    let key;
    try {
      key = decodeKey((await readFile(keyPath, "utf8")).trim());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      key = randomBytes(32);
      try {
        await writeFile(keyPath, `${key.toString("base64")}\n`, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (writeError) {
        if (writeError.code !== "EEXIST") throw writeError;
        key = decodeKey((await readFile(keyPath, "utf8")).trim());
      }
    }
    await chmod(keyPath, 0o600);
    return new DataCipher(key);
  }

  encrypt(value) {
    const plaintext = String(value ?? "");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${prefix}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
  }

  decrypt(value) {
    const serialized = String(value ?? "");
    if (!serialized.startsWith(prefix)) return serialized;
    const payload = Buffer.from(serialized.slice(prefix.length), "base64");
    if (payload.length < 28) throw new Error("Encrypted value is malformed");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  }

  fingerprint(value) {
    return createHmac("sha256", this.key)
      .update(String(value))
      .digest("hex");
  }
}
