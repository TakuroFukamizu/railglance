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

export type RouteCandidatePatch = {
  /** Segment ids whose nodes leave the list. */
  remove: string[];
  /** New candidates, each inserted before the node with `beforeId` (null appends). */
  insert: Array<{ item: RouteCandidateItem; beforeId: string | null }>;
  /** Candidates that stay, with fresh text; their nodes keep their place. */
  update: RouteCandidateItem[];
  /** The list as it stands after the patch, in DOM order. */
  rendered: RouteCandidateItem[];
};

function sameItem(a: RouteCandidateItem, b: RouteCandidateItem): boolean {
  return a.segmentId === b.segmentId && a.lineName === b.lineName && a.detail === b.detail;
}

/**
 * Works out the smallest DOM patch that brings the rendered candidate list up
 * to date, or null when nothing changed.
 *
 * The controller republishes candidates every second, and their distance text
 * (and often their score order) moves with every GPS fix. Destroying and
 * recreating the buttons each tick is what broke the home view on iOS: when
 * the node under a finger is removed, WebKit drops that touch, so a scroll or
 * tap that starts on the list dies within a second (issue #85). Nodes that
 * survive therefore never move; only their text is refreshed. A newcomer is
 * slotted in before the first survivor that ranks below it, and leavers are
 * removed one by one.
 */
export function planRouteCandidateRender(
  rendered: RouteCandidateItem[],
  next: RouteCandidateItem[]
): RouteCandidatePatch | null {
  if (rendered.length === next.length && rendered.every((item, i) => sameItem(item, next[i]))) {
    return null;
  }
  const nextById = new Map(next.map((item) => [item.segmentId, item]));
  const rankOf = new Map(next.map((item, i) => [item.segmentId, i]));

  const remove = rendered.filter((item) => !nextById.has(item.segmentId)).map((item) => item.segmentId);
  const order = rendered
    .filter((item) => nextById.has(item.segmentId))
    .map((item) => nextById.get(item.segmentId) as RouteCandidateItem);
  const update = [...order];

  const insert: RouteCandidatePatch['insert'] = [];
  for (const item of next) {
    if (rendered.some((r) => r.segmentId === item.segmentId)) continue;
    const rank = rankOf.get(item.segmentId) as number;
    const at = order.findIndex((o) => (rankOf.get(o.segmentId) as number) > rank);
    const beforeId = at === -1 ? null : order[at].segmentId;
    insert.push({ item, beforeId });
    order.splice(at === -1 ? order.length : at, 0, item);
  }

  return { remove, insert, update, rendered: order };
}
