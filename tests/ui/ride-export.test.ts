import { describe, expect, it, vi } from 'vitest';
import type { RideRecord } from '../../src/domain/history/ride-record';
import {
  buildRideHistoryExport,
  exportRideHistoryText,
  serializeRideHistoryExport,
} from '../../src/ui/ride-export';

const EXPORTED_AT_MS = Date.UTC(2026, 8, 26, 1, 2, 3);
const PRIMARY_STARTED_AT_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const PRIMARY_ENDED_AT_MS = PRIMARY_STARTED_AT_MS + 125_600;

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
    startedAtMs: PRIMARY_STARTED_AT_MS,
    endedAtMs: PRIMARY_ENDED_AT_MS,
    endReason: 'transfer',
    distanceMeters: 1234.6,
    maxSpeedKmh: 92.66,
    updatedAtMs: PRIMARY_ENDED_AT_MS,
    ...overrides,
  };
}

describe('buildRideHistoryExport', () => {
  it('builds the railglance-ride-history payload with ISO times, rounded numbers and end reasons', () => {
    const primary = makeRide({ id: 'primary' });
    const withoutSpeed = makeRide({
      id: 'no-speed',
      startedAtMs: Date.UTC(2025, 11, 31, 12, 0, 0),
      endedAtMs: Date.UTC(2025, 11, 31, 12, 1, 0),
      operatorName: null,
      directionName: null,
      distanceMeters: 500.2,
      maxSpeedKmh: null,
      endReason: 'stopped',
      passedStations: [{ id: 'machida', name: '町田' }],
    });

    const payload = buildRideHistoryExport([primary, withoutSpeed], EXPORTED_AT_MS, '1.2.3-test');

    expect(payload).toEqual({
      format: 'railglance-ride-history',
      version: 1,
      exportedAt: '2026-09-26T01:02:03.000Z',
      appVersion: '1.2.3-test',
      rides: [
        {
          id: 'primary',
          line: { id: 'odakyu-odawara', name: '小田急小田原線', operator: '小田急電鉄' },
          direction: '新宿方面',
          from: { id: 'ebina', name: '海老名' },
          to: { id: 'sagami-ono', name: '相模大野' },
          passedStations: [
            { id: 'ebina', name: '海老名' },
            { id: 'sagami-ono', name: '相模大野' },
          ],
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:02:05.600Z',
          durationSeconds: 126,
          distanceMeters: 1235,
          maxSpeedKmh: 92.7,
          endReason: 'transfer',
        },
        {
          id: 'no-speed',
          line: { id: 'odakyu-odawara', name: '小田急小田原線', operator: null },
          direction: null,
          from: { id: 'ebina', name: '海老名' },
          to: { id: 'sagami-ono', name: '相模大野' },
          passedStations: [{ id: 'machida', name: '町田' }],
          startedAt: '2025-12-31T12:00:00.000Z',
          endedAt: '2025-12-31T12:01:00.000Z',
          durationSeconds: 60,
          distanceMeters: 500,
          maxSpeedKmh: null,
          endReason: 'stopped',
        },
      ],
    });
    expect(payload.rides[0]?.passedStations).not.toBe(primary.passedStations);
  });

  it('sorts by startedAtMs descending, excludes open records, and does not mutate the input', () => {
    const older = makeRide({ id: 'older', startedAtMs: 1_000, endedAtMs: 2_000 });
    const newer = makeRide({ id: 'newer', startedAtMs: 5_000, endedAtMs: 6_000 });
    const open = makeRide({
      id: 'open',
      status: 'open',
      startedAtMs: 9_000,
      endedAtMs: null,
      endReason: null,
    });
    const noReason = makeRide({
      id: 'no-reason',
      startedAtMs: 8_000,
      endedAtMs: 8_500,
      endReason: null,
    });
    const noEnd = makeRide({
      id: 'no-end',
      status: 'closed',
      startedAtMs: 7_000,
      endedAtMs: null,
      endReason: 'stopped',
    });
    const rides = [older, open, newer, noReason, noEnd];
    const snapshot = structuredClone(rides);

    const payload = buildRideHistoryExport(rides, EXPORTED_AT_MS, '1.2.3-test');

    expect(payload.rides.map((ride) => ride.id)).toEqual(['newer', 'older']);
    expect(rides).toEqual(snapshot);
  });
});

describe('serializeRideHistoryExport', () => {
  it('returns pretty-printed JSON that round-trips through JSON.parse', () => {
    const payload = buildRideHistoryExport([makeRide()], EXPORTED_AT_MS, '1.2.3-test');

    const text = serializeRideHistoryExport(payload);

    expect(text).toBe(JSON.stringify(payload, null, 2));
    expect(JSON.parse(text)).toEqual(payload);
  });
});

describe('exportRideHistoryText', () => {
  const text = '{"format":"railglance-ride-history"}';
  const title = 'RailGlance 乗車履歴';

  it('returns shared when share resolves and does not call copy', async () => {
    const share = vi.fn(async () => {});
    const copy = vi.fn(async () => {});

    await expect(exportRideHistoryText(text, title, { share, copy })).resolves.toBe('shared');

    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith(text, title);
    expect(copy).not.toHaveBeenCalled();
  });

  it('returns cancelled when share rejects with a plain AbortError and does not call copy', async () => {
    const share = vi.fn(async () => {
      throw { name: 'AbortError' };
    });
    const copy = vi.fn(async () => {});

    await expect(exportRideHistoryText(text, title, { share, copy })).resolves.toBe('cancelled');

    expect(share).toHaveBeenCalledWith(text, title);
    expect(copy).not.toHaveBeenCalled();
  });

  it('falls through to copy when share rejects with TypeError', async () => {
    const share = vi.fn(async () => {
      throw new TypeError('navigator.share is not a function');
    });
    const copy = vi.fn(async () => {});

    await expect(exportRideHistoryText(text, title, { share, copy })).resolves.toBe('copied');

    expect(share).toHaveBeenCalledWith(text, title);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(text);
  });

  it('returns manual when neither share nor copy is available', async () => {
    await expect(exportRideHistoryText(text, title, {})).resolves.toBe('manual');
  });

  it('returns manual when copy rejects and share is absent', async () => {
    const copy = vi.fn(async () => {
      throw new Error('clipboard unavailable');
    });

    await expect(exportRideHistoryText(text, title, { copy })).resolves.toBe('manual');

    expect(copy).toHaveBeenCalledWith(text);
  });

  it('returns copied when share is absent and copy resolves', async () => {
    const copy = vi.fn(async () => {});

    await expect(exportRideHistoryText(text, title, { copy })).resolves.toBe('copied');

    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(text);
  });
});
