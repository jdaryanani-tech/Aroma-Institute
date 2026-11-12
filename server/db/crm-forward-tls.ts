import {
  checkServerIdentity,
  type PeerCertificate,
} from "node:tls";

type HostnameVerifier = (hostname: string, certificate: PeerCertificate) => Error | undefined;

export type CrmForwardTlsOptions = {
  rejectUnauthorized: true;
  checkServerIdentity: (hostname: string, certificate: PeerCertificate) => Error | undefined;
};

export function crmForwardTlsOptions(
  hostname: string,
  verifyHostname: HostnameVerifier = checkServerIdentity,
): CrmForwardTlsOptions {
  if (!hostname) throw new Error("CRM_FORWARD_TLS_HOST_REQUIRED");

  return {
    rejectUnauthorized: true,
    // pg 8.16.3 only sets TLS servername for DNS hosts. Bind Node's normal
    // hostname/IP-SAN verifier to the URL host so IP literals are checked too.
    checkServerIdentity: (_servername, certificate) =>
      verifyHostname(hostname, certificate),
  };
}
