import type { RideEndReason, RideRecord, RideStationRef } from '../domain/history/ride-record';

export type RideListItem = {
  id: string;
  lineName: string;
  route: string;
  direction: string;
  when: string;
  duration: string;
  distance: string;
};

export type RideDetailView = RideListItem & {
  startedAt: string;
  endedAt: string;
  operatorName: string;
  maxSpeed: string;
  passedStations: string[];
  endReasonLabel: string;
};

export const RIDE_HISTORY_EMPTY_TEXT =
  '乗車履歴はまだありません。路線が判定された状態で走行すると自動で記録されます';

const END_REASON_LABELS: Record<RideEndReason, string> = {
  transfer: '乗換',
  'route-lost': '路線判定終了',
  stopped: '停車',
  'app-restart': 'アプリ再起動',
};

const WHEN_PARTS: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

const FULL_PARTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

function formatJaDateTime(ms: number, parts: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return new Date(ms).toLocaleString('ja-JP', {
    ...parts,
    hourCycle: 'h23',
    timeZone,
  });
}

function isClosedRide(ride: RideRecord): ride is RideRecord & { endedAtMs: number } {
  return ride.status === 'closed' && ride.endedAtMs !== null;
}

function formatRoute(from: RideStationRef | null, to: RideStationRef | null): string {
  if (from && to) return `${from.name} → ${to.name}`;
  if (from) return `${from.name} →`;
  if (to) return `→ ${to.name}`;
  return '区間不明';
}

export function formatRideDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '1分未満';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '1分未満';
  if (totalMinutes < 60) return `${totalMinutes}分`;
  return `${Math.floor(totalMinutes / 60)}時間${String(totalMinutes % 60).padStart(2, '0')}分`;
}

export function formatRideDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

export function buildRideListItem(ride: RideRecord, timeZone?: string): RideListItem {
  const endedAtMs = ride.endedAtMs ?? ride.startedAtMs;
  return {
    id: ride.id,
    lineName: ride.lineName,
    route: formatRoute(ride.fromStation, ride.toStation),
    direction: ride.directionName ?? '',
    when: formatJaDateTime(ride.startedAtMs, WHEN_PARTS, timeZone),
    duration: formatRideDuration(endedAtMs - ride.startedAtMs),
    distance: formatRideDistance(ride.distanceMeters),
  };
}

export function buildRideDetailView(
  ride: RideRecord,
  expandedId: string | null,
  timeZone?: string,
): RideDetailView | null {
  if (ride.id !== expandedId || !isClosedRide(ride)) return null;
  return {
    ...buildRideListItem(ride, timeZone),
    startedAt: formatJaDateTime(ride.startedAtMs, FULL_PARTS, timeZone),
    endedAt: formatJaDateTime(ride.endedAtMs, FULL_PARTS, timeZone),
    operatorName: ride.operatorName ?? '',
    maxSpeed: ride.maxSpeedKmh === null ? '--' : `${Math.round(ride.maxSpeedKmh)} km/h`,
    passedStations: ride.passedStations.map((station) => station.name),
    endReasonLabel: ride.endReason === null ? '' : END_REASON_LABELS[ride.endReason],
  };
}

export function buildHistoryCardView(
  rides: RideRecord[],
  count: number,
  timeZone?: string,
): { items: RideListItem[]; emptyText: string | null } {
  const items = rides
    .filter(isClosedRide)
    .slice(0, count)
    .map((ride) => buildRideListItem(ride, timeZone));
  return {
    items,
    emptyText: items.length === 0 ? RIDE_HISTORY_EMPTY_TEXT : null,
  };
}

export function buildHistoryListView(
  rides: RideRecord[],
  expandedId: string | null,
  timeZone?: string,
): {
  items: Array<{ item: RideListItem; detail: RideDetailView | null }>;
  emptyText: string | null;
  exportDisabled: boolean;
  clearDisabled: boolean;
} {
  const items = rides.filter(isClosedRide).map((ride) => ({
    item: buildRideListItem(ride, timeZone),
    detail: buildRideDetailView(ride, expandedId, timeZone),
  }));
  const empty = items.length === 0;
  return {
    items,
    emptyText: empty ? RIDE_HISTORY_EMPTY_TEXT : null,
    exportDisabled: empty,
    clearDisabled: empty,
  };
}
