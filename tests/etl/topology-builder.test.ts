import { describe, expect, it } from 'vitest';
import { TopologyBuilder } from '../../src/etl/topology-builder';
import { RailwayLine, Station, TrackSegment } from '../../src/domain/models/railway';

const line: RailwayLine = { id: 'line', operatorId: 'op', name: 'Line' };
const stations: Station[] = [
  { id: 'a', lineId: 'line', name: 'A', sequence: 1, latitude: 35, longitude: 139 },
  { id: 'b', lineId: 'line', name: 'B', sequence: 2, latitude: 35.01, longitude: 139 },
  { id: 'c', lineId: 'line', name: 'C', sequence: 3, latitude: 35.02, longitude: 139 },
];
const segment = (id: string, from: string, to: string, startLat: number): TrackSegment => ({
  id,
  lineId: 'line',
  fromStationId: from,
  toStationId: to,
  coordinates: [[startLat, 139], [startLat + 0.01, 139]],
  lengthMeters: 1000,
});

describe('TopologyBuilder', () => {
  it('orders and links shuffled segments from station topology', () => {
    const result = new TopologyBuilder().buildTopology(
      [line],
      stations,
      [segment('bc', 'b', 'c', 35.01), segment('ab', 'a', 'b', 35)]
    );

    expect(result.routes[0].segmentIds).toEqual(['ab', 'bc']);
    expect(result.segments.map((item) => item.startOffsetMeters)).toEqual([0, 1000]);
    expect(result.segments[0].nextSegmentIds).toEqual(['bc']);
    expect(result.segments[1].previousSegmentIds).toEqual(['ab']);
  });

  it('normalizes a segment whose source direction is reversed', () => {
    const result = new TopologyBuilder().buildTopology(
      [line],
      stations.slice(0, 2),
      [segment('ba', 'b', 'a', 35)]
    );
    expect(result.segments[0].fromStationId).toBe('a');
    expect(result.segments[0].toStationId).toBe('b');
  });

  it('rejects ambiguous branches instead of publishing invalid offsets', () => {
    const branchStation: Station = {
      id: 'd', lineId: 'line', name: 'D', sequence: 3, latitude: 35.02, longitude: 139.01,
    };
    expect(() => new TopologyBuilder().buildTopology(
      [line],
      [...stations, branchStation],
      [
        segment('ab', 'a', 'b', 35),
        segment('bc', 'b', 'c', 35.01),
        { ...segment('bd', 'b', 'd', 35.01), coordinates: [[35.01, 139], [35.02, 139.01]] },
      ]
    )).toThrow(/branches/);
  });

  it('detects a ring and links its first and last segments', () => {
    const result = new TopologyBuilder().buildTopology(
      [line],
      stations,
      [
        segment('ab', 'a', 'b', 35),
        segment('bc', 'b', 'c', 35.01),
        { ...segment('ca', 'c', 'a', 35.02), coordinates: [[35.02, 139], [35, 139]] },
      ]
    );
    expect(result.routes).toHaveLength(1);
    expect(result.segments.at(-1)?.nextSegmentIds).toEqual([result.segments[0].id]);
    expect(result.segments[0].previousSegmentIds).toEqual([result.segments.at(-1)?.id]);
  });

  it('emits separate routes for disconnected components', () => {
    const extraStations: Station[] = [
      { id: 'd', lineId: 'line', name: 'D', sequence: 4, latitude: 35.03, longitude: 139 },
      { id: 'e', lineId: 'line', name: 'E', sequence: 5, latitude: 35.04, longitude: 139 },
    ];
    const result = new TopologyBuilder().buildTopology(
      [line],
      [...stations.slice(0, 2), ...extraStations],
      [segment('ab', 'a', 'b', 35), segment('de', 'd', 'e', 35.03)]
    );
    expect(result.routes).toHaveLength(2);
    expect(result.routes.map((route) => route.segmentIds)).toEqual([['ab'], ['de']]);
  });
});
