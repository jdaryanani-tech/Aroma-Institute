import test from "node:test";
import assert from "node:assert/strict";
import { decryptSubscription, encryptSubscription, isTrustedPushEndpoint, pushEndpointHash } from "./subscription-crypto";

test("push subscriptions are encrypted at rest and endpoint identifiers are one-way hashes",()=>{
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET="calendar-unit-test-only-key";
  try {
    const subscription={endpoint:"https://push.example.test/device",keys:{p256dh:"public",auth:"auth"}};
    const sealed=encryptSubscription(subscription);
    assert.notEqual(sealed.ciphertext,JSON.stringify(subscription));
    assert.deepEqual(decryptSubscription(sealed.ciphertext,sealed.nonce),subscription);
    assert.equal(pushEndpointHash(subscription.endpoint).length,64);
    assert.notEqual(pushEndpointHash(subscription.endpoint),subscription.endpoint);
  } finally {
    if(previous===undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET=previous;
  }
});

test("encrypted push subscriptions reject tampering",()=>{
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET="calendar-unit-test-only-key";
  try {
    const sealed=encryptSubscription({endpoint:"https://push.example.test/device"});
    const changed=sealed.ciphertext.slice(0,-1)+(sealed.ciphertext.endsWith("A")?"B":"A");
    assert.throws(()=>decryptSubscription(changed,sealed.nonce));
  } finally {
    if(previous===undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET=previous;
  }
});

test("push subscription endpoints accept only supported public push services",()=>{
  assert.equal(isTrustedPushEndpoint("https://fcm.googleapis.com/fcm/send/example"),true);
  assert.equal(isTrustedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/example"),true);
  assert.equal(isTrustedPushEndpoint("https://web.push.apple.com/example"),true);
  assert.equal(isTrustedPushEndpoint("https://127.0.0.1/private"),false);
  assert.equal(isTrustedPushEndpoint("http://fcm.googleapis.com/fcm/send/example"),false);
  assert.equal(isTrustedPushEndpoint("https://user:pass@fcm.googleapis.com/fcm/send/example"),false);
});
