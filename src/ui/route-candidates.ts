import type { RouteMatch } from '../domain/models/railway';

export type RouteCandidateItem = {
  segmentId: string;
  lineName: string;
  detail: string;
};

/** Same predicate main.ts used inline before the redesign. */
export function shouldShowRouteCandidates(match: RouteMatch | null, tieMargin: number): boolean {
  if (!match || match.candidates.length === 0) return false;
  const lockState = match.lockState ?? 'UNRESOLVED';
  if (lockState === 'REACQUIRING' || lockState === 'UNRESOLVED') return true;
  return typeof match.scoreMargin === 'number' && match.scoreMargin < tieMargin && match.candidates.length > 1;
}

export function formatCandidateDistance(meters: number): string {
  if (meters < 1000) return `約${Math.round(meters / 10) * 10}m`;
  return `約${(meters / 1000).toFixed(1)}km`;
}

export function buildRouteCandidateItems(match: RouteMatch | null): RouteCandidateItem[] {
  if (!match) return [];
  const nameCounts = new Map<string, number>();
  for (const c of match.candidates) {
    nameCounts.set(c.line.name, (nameCounts.get(c.line.name) ?? 0) + 1);
  }
  return match.candidates.map((c) => {
    const duplicated = (nameCounts.get(c.line.name) ?? 0) > 1;
    const distance = formatCandidateDistance(c.distanceMeters);
    return {
      segmentId: c.segment.id,
      lineName: c.line.name,
      detail: duplicated ? `${distance} · ${c.segment.id}` : distance,
    };
  });
}
