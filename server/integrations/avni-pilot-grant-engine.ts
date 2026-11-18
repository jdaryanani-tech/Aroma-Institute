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
 * This factory is intentionally not wired into the application until the
 * approved Supabase writer and Evolution contract are provided.
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
