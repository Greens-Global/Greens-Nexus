// CA meal and rest breaks (Oct 17 2026): the review needs the employee's
// answer to the meal and rest break question before its envelope is signed
// (backend timesheet_review.break_attestation_state - CA-rule staff only).
export const needsBreakAnswer = (review) => !!(review?.breakAttestation?.required && !review.breakAttestation.answered);
