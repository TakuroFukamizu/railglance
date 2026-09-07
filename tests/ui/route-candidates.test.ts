import { describe, expect, it } from 'vitest';
import {
  buildRouteCandidateItems,
  formatCandidateDistance,
  shouldShowRouteCandidates,
} from '../../src/ui/route-candidates';
import type { RouteCandidateScore, RouteMatch } from '../../src/domain/models/railway';

function candidate(lineName: string, segmentId: string, distanceMeters: number): RouteCandidateScore {
  return {
    segment: { id: segmentId } as RouteCandidateScore['segment'],
    line: { id: lineName, name: lineName } as RouteCandidateScore['line'],
    distanceMeters,
    distanceScore: 0,
    headingScore: 0,
    continuityScore: 0,
    historyScore: 0,
    totalScore: 50,
    projectedPoint: [0, 0],
    bearingDegrees: 0,
  };
}

function match(overrides: Partial<RouteMatch>, candidates: RouteCandidateScore[]): RouteMatch {
  return {
    selectedLine: candidates[0]?.line ?? ({ id: 'x', name: 'x' } as RouteMatch['selectedLine']),
    selectedSegment: candidates[0]?.segment ?? ({ id: 'x' } as RouteMatch['selectedSegment']),
    confidence: 0.8,
    candidates,
    timestampMs: 0,
    lockState: 'LOCKED',
    ...overrides,
  };
}

describe('shouldShowRouteCandidates', () => {
  const two = [candidate('A', 'a-1', 100), candidate('B', 'b-1', 200)];

  it('is false without a match or without candidates', () => {
    expect(shouldShowRouteCandidates(null, 15)).toBe(false);
    expect(shouldShowRouteCandidates(match({ lockState: 'UNRESOLVED' }, []), 15)).toBe(false);
  });

  it('is true while reacquiring or unresolved', () => {
    expect(shouldShowRouteCandidates(match({ lockState: 'REACQUIRING' }, two), 15)).toBe(true);
    expect(shouldShowRouteCandidates(match({ lockState: 'UNRESOLVED' }, two), 15)).toBe(true);
  });

  it('is true when locked but the top two are within the tie margin', () => {
    expect(shouldShowRouteCandidates(match({ lockState: 'LOCKED', scoreMargin: 10 }, two), 15)).toBe(true);
  });

  it('is false when locked with a clear margin or a single candidate', () => {
    expect(shouldShowRouteCandidates(match({ lockState: 'LOCKED', scoreMargin: 30 }, two), 15)).toBe(false);
    expect(shouldShowRouteCandidates(match({ lockState: 'LOCKED', scoreMargin: 5 }, [two[0]]), 15)).toBe(false);
  });
});

describe('formatCandidateDistance', () => {
  it('rounds to 10 m below 1 km', () => {
    expect(formatCandidateDistance(123)).toBe('約120m');
    expect(formatCandidateDistance(125)).toBe('約130m');
    expect(formatCandidateDistance(4)).toBe('約0m');
    expect(formatCandidateDistance(999)).toBe('約1000m');
  });

  it('uses one decimal km from 1000 m', () => {
    expect(formatCandidateDistance(1000)).toBe('約1.0km');
    expect(formatCandidateDistance(1249)).toBe('約1.2km');
  });
});

describe('buildRouteCandidateItems', () => {
  it('returns an empty list without a match', () => {
    expect(buildRouteCandidateItems(null)).toEqual([]);
  });

  it('keeps candidate order and strips scores', () => {
    const items = buildRouteCandidateItems(
      match({}, [candidate('小田急小田原線', 'odk-3', 123), candidate('相鉄本線', 'stt-1', 1400)])
    );
    expect(items).toEqual([
      { segmentId: 'odk-3', lineName: '小田急小田原線', detail: '約120m' },
      { segmentId: 'stt-1', lineName: '相鉄本線', detail: '約1.4km' },
    ]);
  });

  it('adds the segment id to every member of a duplicate-name group only', () => {
    const items = buildRouteCandidateItems(
      match({}, [
        candidate('JR東海道線', 'tk-1', 40),
        candidate('京急本線', 'kq-2', 60),
        candidate('JR東海道線', 'tk-2', 90),
      ])
    );
    expect(items.map((i) => i.detail)).toEqual(['約40m · tk-1', '約60m', '約90m · tk-2']);
  });
});
