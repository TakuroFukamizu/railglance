import { RouteCandidateScore } from '../models/railway';

export function calculateConfidence(
  topCandidate: RouteCandidateScore | null,
  secondCandidate: RouteCandidateScore | null
): number {
  if (!topCandidate) return 0.0;

  // Base confidence on top candidate score
  let confidence = topCandidate.totalScore / 100;

  if (secondCandidate && secondCandidate.totalScore > 0) {
    // If top and 2nd candidates belong to the SAME line (just different segments),
    // line identification is extremely confident!
    if (topCandidate.line.id === secondCandidate.line.id) {
      confidence = Math.max(0.85, confidence);
    } else {
      const margin = (topCandidate.totalScore - secondCandidate.totalScore) / topCandidate.totalScore;
      confidence = confidence * 0.7 + margin * 0.3;
    }
  } else {
    // Single clear candidate line
    confidence = Math.max(0.80, confidence);
  }

  // Cap between 0.0 and 1.0
  confidence = Math.max(0.0, Math.min(1.0, confidence));
  return Math.round(confidence * 100) / 100;
}
