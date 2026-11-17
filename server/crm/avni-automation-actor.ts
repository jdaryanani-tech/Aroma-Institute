import type { Pool } from "pg";
import { normalizeIndianMobile } from "@shared/indian-mobile";
import { crmAccessLevel, type CrmPrincipal } from "./authorization";

export type AvniAutomationActorDiagnostic = {
  matchCount: number;
  active: boolean | null;
  roleNames: string[];
  authorized: boolean;
};

type ActorLookup = {
  diagnostic: AvniAutomationActorDiagnostic;
  principal: CrmPrincipal | null;
};

type ActorRow = {
  id: number | string;
  is_active: boolean;
  roles: string[];
};

/**
 * Uses the same exact phone match and CRM authorization predicate as the
 * automated follow-up writes. The phone and database user ID never leave this
 * server-side helper.
 */
export async function lookupAvniAutomationActor(
  pool: Pick<Pool, "query">,
  suppliedPhone: string,
): Promise<ActorLookup> {
  const normalized = normalizeIndianMobile(suppliedPhone);
  if (!normalized) {
    return {
      diagnostic: { matchCount: 0, active: null, roleNames: [], authorized: false },
      principal: null,
    };
  }

  const { rows } = await pool.query<ActorRow>(
    `SELECT u.id,u.is_active,
       coalesce(array_agg(r.role::text) FILTER(WHERE r.role IS NOT NULL),ARRAY[]::text[]) AS roles
     FROM lms_users u
     LEFT JOIN lms_user_roles r ON r.user_id=u.id
     WHERE u.phone_e164=$1
     GROUP BY u.id,u.is_active`,
    [`+${normalized}`],
  );

  if (rows.length !== 1) {
    return {
      diagnostic: { matchCount: rows.length, active: null, roleNames: [], authorized: false },
      principal: null,
    };
  }

  const row = rows[0];
  const roles = Array.isArray(row.roles)
    ? row.roles.filter((role): role is string => typeof role === "string").sort()
    : [];
  const id = Number(row.id);
  const principal = Number.isSafeInteger(id) ? { id, roles } : null;
  const authorized = row.is_active === true
    && principal !== null
    && crmAccessLevel(principal) !== "denied";

  return {
    diagnostic: {
      matchCount: 1,
      active: row.is_active === true,
      roleNames: roles,
      authorized,
    },
    principal: authorized ? principal : null,
  };
}

export async function inspectAvniAutomationActor(
  pool: Pick<Pool, "query">,
  suppliedPhone: string,
): Promise<AvniAutomationActorDiagnostic> {
  const { diagnostic } = await lookupAvniAutomationActor(pool, suppliedPhone);
  return diagnostic;
}
