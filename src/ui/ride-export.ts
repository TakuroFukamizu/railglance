import type { RideEndReason, RideRecord, RideStationRef } from '../domain/history/ride-record';

export type RideHistoryExport = {
  format: 'railglance-ride-history';
  version: 1;
  exportedAt: string;
  appVersion: string;
  rides: Array<{
    id: string;
    line: { id: string; name: string; operator: string | null };
    direction: string | null;
    from: RideStationRef | null;
    to: RideStationRef | null;
    passedStations: RideStationRef[];
    startedAt: string;
    endedAt: string;
    durationSeconds: number;
    distanceMeters: number;
    maxSpeedKmh: number | null;
    endReason: RideEndReason;
  }>;
};

export type ExportCapabilities = {
  share?: (text: string, title: string) => Promise<void>;
  copy?: (text: string) => Promise<void>;
};

export type ExportOutcome = 'shared' | 'copied' | 'manual' | 'cancelled';

function isExportableRide(
  ride: RideRecord,
): ride is RideRecord & { endedAtMs: number; endReason: RideEndReason } {
  return ride.status === 'closed' && ride.endedAtMs !== null && ride.endReason !== null;
}

/** A dismissed share sheet is `{ name: 'AbortError' }`, including plain objects from WebViews. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function buildRideHistoryExport(
  rides: RideRecord[],
  exportedAtMs: number,
  appVersion: string,
): RideHistoryExport {
  const sorted = rides.filter(isExportableRide).slice();
  sorted.sort((left, right) => right.startedAtMs - left.startedAtMs);
  return {
    format: 'railglance-ride-history',
    version: 1,
    exportedAt: new Date(exportedAtMs).toISOString(),
    appVersion,
    rides: sorted.map((ride) => ({
      id: ride.id,
      line: { id: ride.lineId, name: ride.lineName, operator: ride.operatorName },
      direction: ride.directionName,
      from: ride.fromStation,
      to: ride.toStation,
      passedStations: ride.passedStations.slice(),
      startedAt: new Date(ride.startedAtMs).toISOString(),
      endedAt: new Date(ride.endedAtMs).toISOString(),
      durationSeconds: Math.round((ride.endedAtMs - ride.startedAtMs) / 1000),
      distanceMeters: Math.round(ride.distanceMeters),
      maxSpeedKmh: ride.maxSpeedKmh === null ? null : Math.round(ride.maxSpeedKmh * 10) / 10,
      endReason: ride.endReason,
    })),
  };
}

export function serializeRideHistoryExport(payload: RideHistoryExport): string {
  return JSON.stringify(payload, null, 2);
}

export async function exportRideHistoryText(
  text: string,
  title: string,
  caps: ExportCapabilities,
): Promise<ExportOutcome> {
  if (caps.share) {
    try {
      await caps.share(text, title);
      return 'shared';
    } catch (error) {
      if (isAbortError(error)) return 'cancelled';
    }
  }
  if (caps.copy) {
    try {
      await caps.copy(text);
      return 'copied';
    } catch {
      return 'manual';
    }
  }
  return 'manual';
}
