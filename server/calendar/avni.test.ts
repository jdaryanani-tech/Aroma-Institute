import assert from "node:assert/strict";
import test from "node:test";
import {
  counsellingBookingEligible, explicitStudentConfirmation, hasSlotConflict,
} from "./avni";

test("counselling booking eligibility requires verified VSL and a persisted completed questionnaire", () => {
  const lead = { videoCompletedAt: new Date("2026-01-01T00:00:00Z"), questionnaireStatus: "completed" };
  assert.equal(counsellingBookingEligible(lead, {
    submittedAt: new Date("2026-01-02T00:00:00Z"), answers: { q1: "answer" },
  }), true);
  assert.equal(counsellingBookingEligible({ ...lead, videoCompletedAt: null }, {
    submittedAt: new Date(), answers: { q1: "answer" },
  }), false);
  assert.equal(counsellingBookingEligible(lead, { submittedAt: null, answers: { q1: "answer" } }), false);
  assert.equal(counsellingBookingEligible(lead, { submittedAt: new Date(), answers: null }), false);
});

test("booking and cancellation require a persisted inbound explicit-confirmation message", () => {
  assert.equal(explicitStudentConfirmation({ direction: "inbound", messageType: "booking_confirmation" }, "booking_confirmation"), true);
  assert.equal(explicitStudentConfirmation({ direction: "outbound", messageType: "booking_confirmation" }, "booking_confirmation"), false);
  assert.equal(explicitStudentConfirmation({ direction: "inbound", messageType: "text" }, "booking_confirmation"), false);
  assert.equal(explicitStudentConfirmation({ direction: "inbound", messageType: "booking_cancellation" }, "booking_cancellation"), true);
});

test("calendar slots reject overlapping staff/resource/prospect events but allow adjacent intervals", () => {
  const start = new Date("2026-11-08T10:00:00Z");
  const end = new Date("2026-11-08T11:00:00Z");
  const candidate = { start, end, staffId: 7, resourceId: 4, leadId: "lead-a", inquiryId: 12 };
  assert.equal(hasSlotConflict(candidate, [{
    startsAt: new Date("2026-11-08T10:30:00Z"), endsAt: new Date("2026-11-08T11:30:00Z"),
    ownerId: 2, trainerId: null, resourceId: null, leadId: "lead-a", inquiryId: 12,
  }]), true);
  assert.equal(hasSlotConflict(candidate, [{
    startsAt: new Date("2026-11-08T11:00:00Z"), endsAt: new Date("2026-11-08T12:00:00Z"),
    ownerId: 7, status: "confirmed",
  }]), false);
  assert.equal(hasSlotConflict(candidate, [{
    startsAt: new Date("2026-11-08T10:30:00Z"), endsAt: new Date("2026-11-08T11:30:00Z"),
    trainerId: 7, kind: "session",
  }]), true);
});
