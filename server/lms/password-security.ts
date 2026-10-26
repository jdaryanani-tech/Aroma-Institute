import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

const PASSWORD_HASH_ALGORITHM = "scrypt";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;

function derivePasswordKey(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => {
        if (error) return reject(error);
        resolve(Buffer.from(key));
      },
    );
  });
}

export async function hashLmsPassword(password: string) {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derivedKey = await derivePasswordKey(password, salt);
  return [
    PASSWORD_HASH_ALGORITHM,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyLmsPassword(password: string, encodedHash: string) {
  const [algorithm, cost, blockSize, parallelization, saltText, keyText, extra] =
    encodedHash.split("$");
  if (
    algorithm !== PASSWORD_HASH_ALGORITHM ||
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION ||
    !saltText ||
    !keyText ||
    extra !== undefined
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(saltText, "base64url");
    const expectedKey = Buffer.from(keyText, "base64url");
    if (salt.length !== SCRYPT_SALT_LENGTH || expectedKey.length !== SCRYPT_KEY_LENGTH) {
      return false;
    }
    const actualKey = await derivePasswordKey(password, salt);
    return timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}

export async function verifyLmsPasswordAgainstDummy(password: string) {
  const dummyHash = await getDummyHash();
  return verifyLmsPassword(password, dummyHash);
}

const dummyHashPromise = hashLmsPassword(randomBytes(32).toString("base64url"));

function getDummyHash() {
  return dummyHashPromise;
}

export function normalizeLmsPhone(input: string) {
  const cleaned = input.trim().replace(/[\s().-]/g, "");
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (!cleaned.startsWith("+")) return null;

  const digits = cleaned.slice(1);
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  if (digits.startsWith("91")) {
    if (digits.length !== 12 || !/^[6-9]\d{9}$/.test(digits.slice(2))) return null;
  }
  return `+${digits}`;
}

export function hashPasswordSetupToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createPasswordSetupToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashPasswordSetupToken(token) };
}

export function hashAuthRateLimitKey(purpose: string, value: string) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error("SESSION_SECRET is required for LMS authentication.");
  return createHmac("sha256", sessionSecret)
    .update(`${purpose}:${value}`)
    .digest("hex");
}
