import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

function encryptionKey() {
  const secret=process.env.SESSION_SECRET;
  if(!secret) throw new Error("Push subscription encryption is unavailable.");
  return scryptSync(secret,"aichm-push-subscriptions-v1",32);
}

export function encryptSubscription(value:unknown) {
  const nonce=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",encryptionKey(),nonce);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return {ciphertext:Buffer.concat([ciphertext,cipher.getAuthTag()]).toString("base64url"),nonce:nonce.toString("base64url")};
}

export function decryptSubscription(ciphertext:string,nonce:string) {
  const bytes=Buffer.from(ciphertext,"base64url");
  const tag=bytes.subarray(bytes.length-16);
  const decipher=createDecipheriv("aes-256-gcm",encryptionKey(),Buffer.from(nonce,"base64url"));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString("utf8"));
}

export const pushEndpointHash=(endpoint:string)=>createHash("sha256").update(endpoint).digest("hex");

export function isTrustedPushEndpoint(endpoint:string) {
  try {
    const parsed=new URL(endpoint);
    const host=parsed.hostname.toLowerCase();
    return parsed.protocol==="https:"&&!parsed.username&&!parsed.password&&!parsed.port&&!parsed.hash&&(
      host==="fcm.googleapis.com"||host==="web.push.apple.com"||
      host.endsWith(".push.services.mozilla.com")||host.endsWith(".notify.windows.com")
    );
  } catch { return false; }
}
