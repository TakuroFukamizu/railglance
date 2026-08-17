import { TrackingConfig } from '../../config/tracking-config';
import { ContinuityKind, RouteLockState, TrackSegment } from '../models/railway';

export function segmentsAreAdjacent(a: TrackSegment, b: TrackSegment): boolean {
  if (a.id === b.id) return false;

  const aNeighbors = new Set([...(a.previousSegmentIds ?? []), ...(a.nextSegmentIds ?? [])]);
  if (aNeighbors.has(b.id)) return true;

  const bNeighbors = new Set([...(b.previousSegmentIds ?? []), ...(b.nextSegmentIds ?? [])]);
  if (bNeighbors.has(a.id)) return true;

  if (a.lineId !== b.lineId) return false;

  const aStations = new Set([a.fromStationId, a.toStationId].filter(Boolean));
  const bStations = new Set([b.fromStationId, b.toStationId].filter(Boolean));
  for (const stationId of aStations) {
    if (bStations.has(stationId)) return true;
  }
  return false;
}

export function classifyContinuity(
  previous: TrackSegment | null,
  candidate: TrackSegment,
  nearbySegments: TrackSegment[]
): ContinuityKind {
  if (!previous) return 'unrelated';
  if (previous.id === candidate.id) return 'same-segment';
  if (segmentsAreAdjacent(previous, candidate)) return 'adjacent-segment';

  const sameRoute =
    previous.routeId !== undefined &&
    candidate.routeId !== undefined &&
    previous.routeId === candidate.routeId;
  if (sameRoute || isReachableAlongTopology(previous, candidate, nearbySegments, 8)) {
    return 'reachable-same-route';
  }

  if (previous.lineId === candidate.lineId) return 'same-line-disconnected';
  return 'unrelated';
}

export function continuityBonus(
  kind: ContinuityKind,
  lockState: RouteLockState,
  config: TrackingConfig
): number {
  const base =
    kind === 'same-segment'
      ? config.continuitySameSegment
      : kind === 'adjacent-segment'
        ? config.continuityAdjacentSegment
        : kind === 'reachable-same-route'
          ? config.continuityReachableSameRoute
          : kind === 'same-line-disconnected'
            ? config.continuitySameLineDisconnected
            : 0;

  const scale =
    lockState === 'REACQUIRING'
      ? config.continuityReacquiringScale
      : lockState === 'SUSPICIOUS'
        ? config.continuitySuspiciousScale
        : 1;

  return Math.round(base * scale * 10) / 10;
}

function isReachableAlongTopology(
  from: TrackSegment,
  to: TrackSegment,
  nearbySegments: TrackSegment[],
  maxHops: number
): boolean {
  const sameDefinedRoute = from.routeId !== undefined && from.routeId === to.routeId;
  if (from.lineId !== to.lineId && !sameDefinedRoute) return false;

  const byId = new Map(nearbySegments.map((segment) => [segment.id, segment]));
  byId.set(from.id, from);
  byId.set(to.id, to);

  const queue: Array<{ id: string; hops: number }> = [{ id: from.id, hops: 0 }];
  const seen = new Set<string>([from.id]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === to.id) return true;
    if (current.hops >= maxHops) continue;

    const segment = byId.get(current.id);
    if (!segment) continue;

    const neighborIds = new Set([
      ...(segment.previousSegmentIds ?? []),
      ...(segment.nextSegmentIds ?? []),
    ]);
    for (const other of byId.values()) {
      if (other.id !== segment.id && segmentsAreAdjacent(segment, other)) {
        neighborIds.add(other.id);
      }
    }

    for (const neighborId of neighborIds) {
      if (seen.has(neighborId)) continue;
      seen.add(neighborId);
      queue.push({ id: neighborId, hops: current.hops + 1 });
    }
  }

  return false;
}
