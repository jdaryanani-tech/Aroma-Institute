import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCrmMetaPhoneIdentityDiagnosticsPostconditions,
  assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent,
  CRM_META_PHONE_DIAGNOSTIC_CHECK_EXPRESSION,
} from "./crm-meta-phone-identity-diagnostics-postconditions";

const columnSpecs = [
  ["phone_number_field_state", "text"],
  ["mobile_phone_field_state", "text"],
  ["whatsapp_number_field_state", "text"],
  ["phone_normalization_outcome", "text"],
  ["phone_selected_field", "text"],
  ["phone_fallback_attempted", "boolean"],
  ["phone_invalid_higher_priority_blocked_fallback", "boolean"],
] as const;

function createClient(options: { conflict?: boolean; driftColumn?: boolean; driftCheck?: boolean } = {}) {
  const columns = columnSpecs.map(([column_name, data_type]) => ({
    column_name,
    data_type: options.driftColumn && column_name === "phone_selected_field" ? "jsonb" : data_type,
    not_null: false,
    default_expression: null,
    generated: "",
    identity: "",
  }));
  return {
    async query(query: string) {
      if (query.includes("pg_get_expr(k.conbin")) {
        return {
          rows: [{
            constraint_name: "admissions_meta_lead_links_phone_diag_ck",
            type: "c",
            validated: true,
            check_expression: options.driftCheck ? "true" : CRM_META_PHONE_DIAGNOSTIC_CHECK_EXPRESSION,
          }],
        };
      }
      if (query.includes("FROM pg_constraint") && query.includes("conname AS constraint_name")) {
        return { rows: options.conflict ? [{ constraint_name: "diagnostic_constraint" }] : [] };
      }
      if (query.includes("a.attname=ANY") && query.includes("format_type")) {
        return { rows: columns };
      }
      if (query.includes("a.attname=ANY")) {
        return { rows: options.conflict ? [{ column_name: "phone_number_field_state" }] : [] };
      }
      throw new Error(`unexpected query: ${query}`);
    },
  };
}

test("diagnostic schema precondition accepts only a fully absent additive extension", async () => {
  await assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent(createClient() as never);
  await assert.rejects(
    assertCrmMetaPhoneIdentityDiagnosticsSchemaAbsent(createClient({ conflict: true }) as never),
    { code: "CRM_META_PHONE_DIAGNOSTICS_SCHEMA_CONFLICT" },
  );
});

test("diagnostic schema postconditions require exact nullable columns and validated allowlist constraint", async () => {
  await assertCrmMetaPhoneIdentityDiagnosticsPostconditions(createClient() as never);
  await assert.rejects(
    assertCrmMetaPhoneIdentityDiagnosticsPostconditions(createClient({ driftColumn: true }) as never),
    { code: "CRM_META_PHONE_DIAGNOSTICS_COLUMNS_DRIFTED" },
  );
  await assert.rejects(
    assertCrmMetaPhoneIdentityDiagnosticsPostconditions(createClient({ driftCheck: true }) as never),
    { code: "CRM_META_PHONE_DIAGNOSTICS_CONSTRAINT_DRIFTED" },
  );
});
