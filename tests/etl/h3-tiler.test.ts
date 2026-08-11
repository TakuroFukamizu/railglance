import { describe, expect, it } from 'vitest';
import { isValidCell } from 'h3-js';
import { H3Tiler } from '../../src/etl/h3-tiler';
import { RailwayLine, Station, TrackSegment } from '../../src/domain/models/railway';

describe('H3Tiler', () => {
  it('uses valid H3 resolution 6 cells and returns the boundary neighbor ring', () => {
    const tiler = new H3Tiler(6);
    const cells = tiler.coverageCellIds(35.6812, 139.7671, 1);
    expect(cells).toHaveLength(7);
    expect(cells.every(isValidCell)).toBe(true);
  });

  it('indexes every crossed cell of a sparse long segment', () => {
    const tiler = new H3Tiler(6);
    const line: RailwayLine = { id: 'line', operatorId: 'operator', name: 'Line' };
    const stations: Station[] = [
      { id: 'tokyo', lineId: 'line', name: 'Tokyo', sequence: 1, latitude: 35.6812, longitude: 139.7671 },
      { id: 'utsunomiya', lineId: 'line', name: 'Utsunomiya', sequence: 2, latitude: 36.559, longitude: 139.8983 },
    ];
    const segment: TrackSegment = {
      id: 'long',
      lineId: 'line',
      routeId: 'route-line-main',
      fromStationId: 'tokyo',
      toStationId: 'utsunomiya',
      coordinates: [[35.6812, 139.7671], [36.559, 139.8983]],
      startOffsetMeters: 0,
    };

    const tiles = tiler.generateTiles([line], [], stations, [segment]);
    const segmentCells = [...tiles.values()].filter((tile) => tile.segments.some((item) => item.id === 'long'));
    expect(segmentCells.length).toBeGreaterThan(10);
    expect(segmentCells.every((tile) => tile.stations.length === 2)).toBe(true);
  });
});
