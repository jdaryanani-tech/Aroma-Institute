export function calculateAssessmentScore(correctAnswers: number, questionCount: number) {
  if (
    !Number.isInteger(questionCount) ||
    questionCount < 1 ||
    !Number.isInteger(correctAnswers) ||
    correctAnswers < 0 ||
    correctAnswers > questionCount
  ) {
    throw new RangeError("Assessment score inputs are outside the valid range.");
  }

  const scorePercent = Math.round((correctAnswers / questionCount) * 100);
  return {
    scorePercent,
    passed: scorePercent === 100,
  };
}
