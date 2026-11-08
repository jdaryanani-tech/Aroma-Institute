import type { RequestHandler } from "express";
import {
  runSupabaseAvniReadDiagnostics,
  type SupabaseAvniDiagnosticChecks,
  type SupabaseAvniReadEnvironment,
} from "../db/supabase-avni-readonly";
import {
  N8N_INTEGRATION_SECRET_ENV,
  N8N_INTEGRATION_SECRET_HEADER,
  verifyN8nIntegrationSecret,
} from "./n8n-auth";

export type AvniDiagnosticsChecks = SupabaseAvniDiagnosticChecks & {
  integrationSecretConfigured: boolean;
  requestAuthenticated: boolean;
  operationalApiReady: boolean;
};

type AvniDiagnosticsDependencies = {
  environment?: SupabaseAvniReadEnvironment;
  runReaderDiagnostics?: (
    environment: SupabaseAvniReadEnvironment,
  ) => Promise<SupabaseAvniDiagnosticChecks>;
  checkOperationalApiReady?: () => Promise<boolean>;
};

const failedReaderChecks = (): SupabaseAvniDiagnosticChecks => ({
  readerUrlPresent: false,
  readerUrlValid: false,
  readerCaPresent: false,
  readerCaAccepted: false,
  tlsConfigStrict: false,
  tlsConnected: false,
  tlsChainVerified: false,
  tlsHostnameVerified: false,
  readerDatabaseIsPostgres: false,
  readerRoleIsDedicated: false,
  readerSessionIsReadOnly: false,
  conversationsRpcExecutes: false,
  syntheticConversationIsEmpty: false,
  confirmationRpcExecutes: false,
  syntheticConfirmationIsFalse: false,
  publicLeadsSelectDenied: false,
  publicConversationsSelectDenied: false,
});

export function createAvniDiagnosticsHandler(
  dependencies: AvniDiagnosticsDependencies = {},
): RequestHandler {
  const environment = dependencies.environment ?? process.env;
  const runReaderDiagnostics = dependencies.runReaderDiagnostics ?? runSupabaseAvniReadDiagnostics;
  const checkOperationalApiReady = dependencies.checkOperationalApiReady ?? (async () => false);

  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Vary", N8N_INTEGRATION_SECRET_HEADER);

    const expectedSecret = environment[N8N_INTEGRATION_SECRET_ENV];
    if (!expectedSecret?.trim()) {
      return void res.status(503).json({
        status: "fail",
        checks: { integrationSecretConfigured: false, requestAuthenticated: false },
      });
    }
    if (!verifyN8nIntegrationSecret(
      req.get(N8N_INTEGRATION_SECRET_HEADER) ?? "",
      expectedSecret,
    )) {
      return void res.status(401).json({
        status: "fail",
        checks: { requestAuthenticated: false },
      });
    }

    let readerChecks = failedReaderChecks();
    try {
      readerChecks = await runReaderDiagnostics(environment);
    } catch {
      // Keep all diagnostic failure details out of logs and HTTP responses.
    }
    let operationalApiReady = false;
    try {
      operationalApiReady = await checkOperationalApiReady();
    } catch {
      operationalApiReady = false;
    }

    const checks: AvniDiagnosticsChecks = {
      integrationSecretConfigured: true,
      requestAuthenticated: true,
      ...readerChecks,
      operationalApiReady,
    };
    const passed = Object.values(checks).every((value) => value === true);
    return void res.status(passed ? 200 : 503).json({
      status: passed ? "pass" : "fail",
      checks,
    });
  };
}
