import assert from "node:assert/strict";
import test from "node:test";
import { calculateAssessmentScore } from "./assessment-scoring";

test("a perfect score passes", () => {
  assert.deepEqual(calculateAssessmentScore(10, 10), {
    scorePercent: 100,
    passed: true,
  });
});

test("a score below 100 percent fails", () => {
  assert.deepEqual(calculateAssessmentScore(99, 100), {
    scorePercent: 99,
    passed: false,
  });
});

test("zero correct answers fail", () => {
  assert.deepEqual(calculateAssessmentScore(0, 3), {
    scorePercent: 0,
    passed: false,
  });
});

test("invalid question counts and correct-answer counts are rejected", () => {
  assert.throws(() => calculateAssessmentScore(0, 0), RangeError);
  assert.throws(() => calculateAssessmentScore(-1, 3), RangeError);
  assert.throws(() => calculateAssessmentScore(4, 3), RangeError);
});
