import { describe, expect, it } from 'vitest';
import type { RideEndReason, RideRecord } from '../../src/domain/history/ride-record';
import {
  RIDE_HISTORY_EMPTY_TEXT,
  buildHistoryCardView,
  buildHistoryListView,
  buildRideDetailView,
  buildRideListItem,
  formatRideDistance,
  formatRideDuration,
} from '../../src/ui/ride-history-view';

const TZ = 'Asia/Tokyo';
const STARTED_AT_MS = Date.UTC(2026, 8, 25, 22, 41);

function makeRide(overrides: Partial<RideRecord> = {}): RideRecord {
  return {
    recordVersion: 1,
    id: 'ride-1',
    status: 'closed',
    lineId: 'odakyu-odawara',
    lineName: '小田急小田原線',
    operatorName: '小田急電鉄',
    directionName: '新宿方面',
    fromStation: { id: 'ebina', name: '海老名' },
    toStation: { id: 'sagami-ono', name: '相模大野' },
    passedStations: [
      { id: 'ebina', name: '海老名' },
      { id: 'sagami-ono', name: '相模大野' },
    ],
    startedAtMs: STARTED_AT_MS,
    endedAtMs: STARTED_AT_MS + 1_500_000,
    endReason: 'transfer',
    distanceMeters: 12_345,
    maxSpeedKmh: 92.6,
    updatedAtMs: STARTED_AT_MS + 1_500_000,
    ...overrides,
  };
}

describe('formatRideDuration', () => {
  it('formats 59 seconds as 1分未満', () => {
    expect(formatRideDuration(59_000)).toBe('1分未満');
    expect(formatRideDuration(0)).toBe('1分未満');
    expect(formatRideDuration(-1)).toBe('1分未満');
    expect(formatRideDuration(Number.NaN)).toBe('1分未満');
  });

  it('formats 60 seconds as 1分', () => {
    expect(formatRideDuration(60_000)).toBe('1分');
  });

  it('formats 60 minutes as 1時間00分', () => {
    expect(formatRideDuration(3_600_000)).toBe('1時間00分');
  });

  it('formats 1 hour 5 minutes as 1時間05分 and 25 minutes as 25分', () => {
    expect(formatRideDuration(3_900_000)).toBe('1時間05分');
    expect(formatRideDuration(1_500_000)).toBe('25分');
  });
});

describe('formatRideDistance', () => {
  it('rounds distances below 1000 m to the nearest 10 m', () => {
    expect(formatRideDistance(999)).toBe('1000m');
    expect(formatRideDistance(620)).toBe('620m');
  });

  it('formats 1000 m and above with one decimal kilometre', () => {
    expect(formatRideDistance(1000)).toBe('1.0km');
    expect(formatRideDistance(12_345)).toBe('12.3km');
  });
});

describe('buildHistoryCardView', () => {
  it('returns the empty-state sentence when there are no rides', () => {
    expect(RIDE_HISTORY_EMPTY_TEXT).toBe(
      '乗車履歴はまだありません。路線が判定された状態で走行すると自動で記録されます',
    );
    expect(buildHistoryCardView([], 3, TZ)).toEqual({
      items: [],
      emptyText: '乗車履歴はまだありません。路線が判定された状態で走行すると自動で記録されます',
    });
  });

  it('slices to count items in input order and clears emptyText', () => {
    const rides = ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      makeRide({ id, startedAtMs: STARTED_AT_MS + index * 60_000 }),
    );

    const view = buildHistoryCardView(rides, 3, TZ);

    expect(view.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(view.emptyText).toBeNull();
  });
});

describe('route text', () => {
  it('joins both stations with an arrow', () => {
    expect(buildRideListItem(makeRide(), TZ).route).toBe('海老名 → 相模大野');
  });

  it('keeps a trailing arrow when only the origin is known', () => {
    expect(buildRideListItem(makeRide({ toStation: null }), TZ).route).toBe('海老名 →');
  });

  it('keeps a leading arrow when only the destination is known', () => {
    expect(buildRideListItem(makeRide({ fromStation: null }), TZ).route).toBe('→ 相模大野');
  });

  it('uses 区間不明 when both stations are missing', () => {
    expect(buildRideListItem(makeRide({ fromStation: null, toStation: null }), TZ).route).toBe('区間不明');
  });
});

describe('ride list and detail fields', () => {
  it('formats when, startedAt and endedAt in Asia/Tokyo and fills direction, distance and duration', () => {
    const ride = makeRide({
      directionName: null,
      operatorName: null,
      distanceMeters: 12_345,
      endedAtMs: STARTED_AT_MS + 1_500_000,
    });

    const card = buildHistoryCardView([ride], 1, TZ);
    expect(card.items[0]).toMatchObject({
      id: ride.id,
      lineName: '小田急小田原線',
      route: '海老名 → 相模大野',
      direction: '',
      when: '09/26 07:41',
      duration: '25分',
      distance: '12.3km',
    });

    const list = buildHistoryListView([ride], ride.id, TZ);
    expect(list.items[0]?.item.when).toBe('09/26 07:41');
    expect(list.items[0]?.item.duration).toBe('25分');
    expect(list.items[0]?.item.distance).toBe('12.3km');
    expect(list.items[0]?.item.direction).toBe('');
    expect(list.items[0]?.detail?.startedAt).toBe('2026/09/26 07:41');
    expect(list.items[0]?.detail?.endedAt).toBe('2026/09/26 08:06');
    expect(buildRideDetailView(ride, ride.id, TZ)?.startedAt).toBe('2026/09/26 07:41');
    expect(buildRideDetailView(ride, ride.id, TZ)?.endedAt).toBe('2026/09/26 08:06');
  });

  it('expands only the ride whose id equals expandedId', () => {
    const fast = makeRide({
      id: 'fast',
      operatorName: '小田急電鉄',
      maxSpeedKmh: 92.6,
      passedStations: [
        { id: 'ebina', name: '海老名' },
        { id: 'zama', name: '座間' },
        { id: 'sagami-ono', name: '相模大野' },
      ],
    });
    const slow = makeRide({
      id: 'slow',
      operatorName: null,
      maxSpeedKmh: null,
      passedStations: [{ id: 'machida', name: '町田' }],
    });

    const expanded = buildHistoryListView([fast, slow], 'fast', TZ);
    expect(expanded.items[0]?.detail).toMatchObject({
      operatorName: '小田急電鉄',
      maxSpeed: '93 km/h',
      passedStations: ['海老名', '座間', '相模大野'],
    });
    expect(expanded.items[1]?.detail).toBeNull();

    const collapsed = buildHistoryListView([fast, slow], null, TZ);
    expect(collapsed.items.map((row) => row.detail)).toEqual([null, null]);

    const slowExpanded = buildHistoryListView([fast, slow], 'slow', TZ);
    expect(slowExpanded.items[0]?.detail).toBeNull();
    expect(slowExpanded.items[1]?.detail).toMatchObject({
      operatorName: '',
      maxSpeed: '--',
      passedStations: ['町田'],
    });
    expect(buildRideDetailView(fast, 'slow', TZ)).toBeNull();
    expect(buildRideDetailView(fast, null, TZ)).toBeNull();
  });

  it('labels all four end reasons', () => {
    const labels: Array<[RideEndReason, string]> = [
      ['transfer', '乗換'],
      ['route-lost', '路線判定終了'],
      ['stopped', '停車'],
      ['app-restart', 'アプリ再起動'],
    ];

    for (const [endReason, endReasonLabel] of labels) {
      const detail = buildRideDetailView(makeRide({ id: endReason, endReason }), endReason, TZ);
      expect(detail?.endReasonLabel).toBe(endReasonLabel);
    }

    expect(buildRideDetailView(makeRide({ id: 'none', endReason: null }), 'none', TZ)?.endReasonLabel).toBe('');
  });
});

describe('buildHistoryListView actions', () => {
  it('disables export and clear when the list is empty and enables them otherwise', () => {
    const empty = buildHistoryListView([], null, TZ);
    expect(empty.items).toEqual([]);
    expect(empty.emptyText).toBe('乗車履歴はまだありません。路線が判定された状態で走行すると自動で記録されます');
    expect(empty.exportDisabled).toBe(true);
    expect(empty.clearDisabled).toBe(true);

    const filled = buildHistoryListView([makeRide()], null, TZ);
    expect(filled.emptyText).toBeNull();
    expect(filled.exportDisabled).toBe(false);
    expect(filled.clearDisabled).toBe(false);
  });

  it('does not mutate the input and skips rides that are still open', () => {
    const closed = makeRide({ id: 'closed' });
    const open = makeRide({
      id: 'open',
      status: 'open',
      endedAtMs: null,
      endReason: null,
    });
    const unfinished = makeRide({
      id: 'unfinished',
      status: 'closed',
      endedAtMs: null,
    });
    const rides = [closed, open, unfinished];
    const snapshot = structuredClone(rides);

    const card = buildHistoryCardView(rides, 3, TZ);
    const list = buildHistoryListView(rides, 'closed', TZ);

    expect(rides).toEqual(snapshot);
    expect(card.items.map((item) => item.id)).toEqual(['closed']);
    expect(list.items.map((row) => row.item.id)).toEqual(['closed']);
    expect(list.items[0]?.detail?.id).toBe('closed');
  });
});
