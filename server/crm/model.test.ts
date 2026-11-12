import assert from "node:assert/strict";
import test from "node:test";
import { crmModelSql } from "./model";

const completeSchema = {
  identityTracking: true,
  videoTracking: true,
  crmPersistence: true,
  chatHistory: false,
  canonicalAssignments: true,
  calendarBookingVerification: true,
  deliveryAttempts: true,
  metaAttribution: true,
};

test("admin CRM model closes the keyed CTE before grouped", () => {
  const sql = crmModelSql(completeSchema);
  assert.match(sql, /FROM associated\s+\),\s*grouped AS \(/);
  assert.doesNotMatch(sql, /FROM associated\s*,\s*grouped AS \(/);
});

test("admissions CRM model places scoped_keyed between keyed and grouped CTEs", () => {
  const sql = crmModelSql(completeSchema, 1);
  assert.match(sql, /FROM associated\s+\),\s*scoped_keyed AS \([\s\S]*?\),\s*grouped AS \(/);
  assert.doesNotMatch(sql, /FROM associated\s*,\s*scoped_keyed AS \(/);
});
