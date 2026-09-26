export type RideEndReason = 'transfer' | 'route-lost' | 'stopped' | 'app-restart';

export type RideStationRef = { id: string; name: string };

export type RideRecord = {
  recordVersion: 1;
  id: string; // crypto.randomUUID()（無ければ時刻 + 乱数のフォールバック）
  status: 'open' | 'closed';
  lineId: string;
  lineName: string;
  operatorName: string | null;
  directionName: string | null; // JourneyState.directionName
  fromStation: RideStationRef | null;
  toStation: RideStationRef | null;
  passedStations: RideStationRef[]; // previousStation が変わるたびに追記（from を含む、重複連続なし）
  startedAtMs: number;
  endedAtMs: number | null; // open のあいだは null
  endReason: RideEndReason | null;
  distanceMeters: number;
  maxSpeedKmh: number | null; // speedState.smoothedSpeedKmh の最大
  updatedAtMs: number; // 最後に store へ書いた tick の時刻
};

export function createRideId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `ride-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
