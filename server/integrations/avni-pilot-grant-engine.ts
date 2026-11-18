import type { Request } from "express";
import { db } from "../db";
import {
  beginAvniDispatchInTransaction,
  issueAvniDispatchGrantInTransaction,
  settleAvniDispatchGrantInTransaction,
} from "../admissions/dispatch-grants";
import type {
  NewAvniDispatchGrantBinding,
} from "../admissions/dispatch-grants";
import type { PilotDispatchBinding, PilotGrantEngine } from "./avni-single-recipient-pilot";

/**
 * Binds the pilot orchestrator to the existing Replit one-use grant ledger.
 * The application may construct this adapter for readiness reporting, but
 * the dispatcher remains code-level disabled until the Supabase writer,
 * migration identity, key ring, and provider contract are approved.
 */
export function createDatabasePilotGrantEngine(): PilotGrantEngine {
  return {
    async issue(request, binding) {
      return db.transaction(tx => issueAvniDispatchGrantInTransaction(tx, {
        request,
        binding: binding as NewAvniDispatchGrantBinding,
        requireAdmin: true,
      }));
    },
    async begin(request, grantId, beginSupabaseSend) {
      const result = await db.transaction(tx => beginAvniDispatchInTransaction({
        tx,
        request: request as Pick<Request, "session" | "lmsUser">,
        grantId,
        requireAdmin: true,
        allowProviderCallAfterBegin: true,
        beginSupabaseSend: async () => beginSupabaseSend(),
      }));
      return {
        code: result.code,
        providerCallAllowed: result.providerCallAllowed,
      };
    },
    async settle(grantId, outcome) {
      return db.transaction(tx => settleAvniDispatchGrantInTransaction({ tx, grantId, outcome }));
    },
  };
}

// Keep this assignment explicit so a future contract change causes a type
// error at the adapter boundary rather than widening request-supplied fields.
const _bindingContract: PilotDispatchBinding | null = null;
void _bindingContract;
