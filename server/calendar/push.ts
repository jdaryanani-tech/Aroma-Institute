import webPush from "web-push";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { notificationDeliveryLogs, pushSubscriptions } from "@shared/calendar-schema";
import { decryptSubscription, encryptSubscription, pushEndpointHash } from "./subscription-crypto";

const PUBLIC_KEY_ENV = "AICHM_VAPID_PUBLIC_KEY";
const PRIVATE_KEY_ENV = "AICHM_VAPID_PRIVATE_KEY";
const VAPID_SUBJECT = "https://aromacafeinstitute.in";

export function getPushConfiguration() {
  const publicKey = process.env[PUBLIC_KEY_ENV]?.trim() ?? "";
  const privateKey = process.env[PRIVATE_KEY_ENV]?.trim() ?? "";
  return {
    configured: Boolean(publicKey && privateKey),
    publicKey: publicKey || null,
    publicKeyPresent: Boolean(publicKey),
    privateKeyPresent: Boolean(privateKey),
  };
}

function configureVapid() {
  const config = getPushConfiguration();
  if (!config.configured) return false;
  webPush.setVapidDetails(VAPID_SUBJECT, config.publicKey!, process.env[PRIVATE_KEY_ENV]!.trim());
  return true;
}

export async function sendPushNotification(input: {
  userId: number;
  notificationId: number;
  scope: "admin" | "learn";
  url: string;
  attemptNumber?: number;
}) {
  let configured=false;
  try { configured=configureVapid(); } catch { configured=false; }
  if (!configured) return { sent: 0, failed: 0, configured: false };
  const subscriptions = (await db.select().from(pushSubscriptions).where(and(
    eq(pushSubscriptions.userId, input.userId),
    eq(pushSubscriptions.active, true),
  ))).filter(subscription=>subscription.appScope===input.scope);
  let sent = 0;
  let failed = 0;
  for (const item of subscriptions) {
    if(item.expirationTime&&item.expirationTime<=new Date()) {
      await db.update(pushSubscriptions).set({active:false,updatedAt:new Date()}).where(eq(pushSubscriptions.id,item.id));
      continue;
    }
    const [alreadySent]=await db.select({id:notificationDeliveryLogs.id}).from(notificationDeliveryLogs).where(and(
      eq(notificationDeliveryLogs.notificationId,input.notificationId),
      eq(notificationDeliveryLogs.subscriptionId,item.id),
      eq(notificationDeliveryLogs.state,"sent"),
    )).limit(1);
    if(alreadySent) continue;
    const attemptNumber = input.attemptNumber ?? 1;
    try {
      const subscription = decryptSubscription(item.subscriptionCiphertext, item.nonce) as webPush.PushSubscription;
      await webPush.sendNotification(
        subscription,
        JSON.stringify({ notificationId: input.notificationId, scope: input.scope, url: input.url }),
        { TTL: 3600, timeout: 10_000 },
      );
      await db.insert(notificationDeliveryLogs).values({
        notificationId: input.notificationId,
        subscriptionId: item.id,
        attemptNumber,
        state: "sent",
        httpStatus: 201,
      });
      await db.update(pushSubscriptions).set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(pushSubscriptions.id, item.id));
      sent++;
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode) : null;
      const expired = status === 404 || status === 410;
      await db.insert(notificationDeliveryLogs).values({
        notificationId: input.notificationId,
        subscriptionId: item.id,
        attemptNumber,
        state: expired ? "expired" : "failed",
        httpStatus: Number.isInteger(status) ? status : null,
        errorSummary: expired ? "Push subscription expired." : "Push delivery failed.",
      });
      if (expired) {
        await db.update(pushSubscriptions).set({ active: false, updatedAt: new Date() })
          .where(eq(pushSubscriptions.id, item.id));
      }
      failed++;
    }
  }
  return { sent, failed, configured: true };
}
