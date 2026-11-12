import assert from "node:assert/strict";
import test from "node:test";
import type { PeerCertificate } from "node:tls";
import { crmForwardTlsOptions } from "./crm-forward-tls";

test("CRM forward TLS always rejects untrusted certificates", () => {
  assert.equal(crmForwardTlsOptions("db.example.test").rejectUnauthorized, true);
});

test("CRM forward TLS verifies DNS names against the parsed target host", () => {
  const verifiedHosts: string[] = [];
  const options = crmForwardTlsOptions("db.example.test", hostname => {
    verifiedHosts.push(hostname);
    return undefined;
  });

  options.checkServerIdentity("driver-supplied-name", {} as PeerCertificate);
  assert.deepEqual(verifiedHosts, ["db.example.test"]);
});

test("CRM forward TLS verifies IP literals rather than relying on pg SNI behavior", () => {
  const verifiedHosts: string[] = [];
  const options = crmForwardTlsOptions("192.0.2.12", hostname => {
    verifiedHosts.push(hostname);
    return undefined;
  });

  options.checkServerIdentity("", {} as PeerCertificate);
  assert.deepEqual(verifiedHosts, ["192.0.2.12"]);
});

test("CRM forward TLS rejects an empty hostname", () => {
  assert.throws(() => crmForwardTlsOptions(""), {
    message: "CRM_FORWARD_TLS_HOST_REQUIRED",
  });
});
