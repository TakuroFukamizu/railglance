import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MlitRailwayAdapter } from '../../src/etl/adapters/mlit-adapter';
import { TopologyBuilder } from '../../src/etl/topology-builder';
import { Station, TrackSegment } from '../../src/domain/models/railway';

const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-mlit-test-'));
const LINE_NAME = '試験線';
const OPERATOR = '試験鉄道';
const LINE_KEY = `${OPERATOR}\u0000${LINE_NAME}`;
const BASE_PROPERTIES = {
  N02_001: '12', N02_002: '5', N02_003: LINE_NAME, N02_004: OPERATOR,
};

function writeGeoJson(filename: string, features: unknown[]): void {
  fs.writeFileSync(path.join(sourceDirectory, filename), JSON.stringify({ type: 'FeatureCollection', features }));
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function stationFeature(name: string, code: string, lon: number, lat: number) {
  return {
    type: 'Feature',
    properties: { ...BASE_PROPERTIES, N02_005: name, N02_005c: code },
    geometry: { type: 'LineString', coordinates: [[lon, lat], [lon, lat]] },
  };
}

function sectionFeature(coordinates: Array<[number, number]>) {
  return {
    type: 'Feature',
    properties: BASE_PROPERTIES,
    geometry: { type: 'LineString', coordinates },
  };
}

async function loadFixture(stations: unknown[], sections: unknown[]) {
  writeGeoJson('N02-23_Station.geojson', stations);
  writeGeoJson('N02-23_RailroadSection.geojson', sections);
  return new MlitRailwayAdapter({ sourceDirectory, strict: true }).load();
}

function originalLineId(): string {
  return `mlit-line-${hash(LINE_KEY)}`;
}

function originalStationId(code: string): string {
  return `mlit-station-${hash(`${LINE_KEY}:${code}`)}`;
}

function identitySnapshot(result: { lines: Array<{ id: string; name: string }>; stations: Station[]; segments: TrackSegment[] }) {
  return {
    lines: result.lines.map((line) => ({ id: line.id, name: line.name })),
    stations: result.stations.map((station) => ({
      id: station.id, lineId: station.lineId, name: station.name, sequence: station.sequence,
    })),
    segments: result.segments.map((segment) => ({
      id: segment.id, lineId: segment.lineId, fromStationId: segment.fromStationId, toStationId: segment.toStationId,
    })),
  };
}

function uniqueNeighborCounts(stations: Station[], segments: TrackSegment[]): number[] {
  const adjacency = new Map<string, Set<string>>();
  for (const station of stations) adjacency.set(station.id, new Set());
  for (const segment of segments) {
    adjacency.get(segment.fromStationId)?.add(segment.toStationId);
    adjacency.get(segment.toStationId)?.add(segment.fromStationId);
  }
  return [...adjacency.values()].map((neighbors) => neighbors.size);
}

afterAll(() => {
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
});

describe('MlitRailwayAdapter', () => {
  it('converts real N02 GeoJSON attributes and keeps provenance', async () => {
    const result = await loadFixture(
      [
        stationFeature('始点', '001', 139, 35),
        stationFeature('終点', '002', 139, 35.01),
      ],
      [sectionFeature([[139, 35], [139, 35.005], [139, 35.01]])],
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ name: '試験線', operatorName: '試験鉄道' });
    expect(result.stations.map((station) => station.sequence)).toEqual([1, 2]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].coordinates[0]).toEqual([35, 139]);
    expect(result.segments[0].provenance?.[0]).toMatchObject({
      sourceId: 'mlit-n02-23',
      licenseId: 'CC-BY-4.0',
    });
  });

  it('requires an explicit source for a publishable build', async () => {
    await expect(new MlitRailwayAdapter({ sourceDirectory: '', strict: true }).load()).rejects.toThrow(/MLIT_N02_DIR/);
  });

  it('emits a plain linear line unchanged, including ids and station sequence', async () => {
    const result = await loadFixture(
      [
        stationFeature('始点', '001', 139, 35),
        stationFeature('中間', '002', 139, 35.01),
        stationFeature('終点', '003', 139, 35.02),
      ],
      [
        sectionFeature([[139, 35], [139, 35.01]]),
        sectionFeature([[139, 35.01], [139, 35.02]]),
      ],
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].id).toBe(originalLineId());
    expect(result.lines[0].name).toBe(LINE_NAME);
    expect(result.lines[0].operatorName).toBe(OPERATOR);
    expect(result.stations).toHaveLength(3);
    expect(result.stations.map((station) => station.sequence)).toEqual([1, 2, 3]);
    expect(result.stations.map((station) => station.id).sort()).toEqual(
      ['001', '002', '003'].map(originalStationId).sort(),
    );
    expect(result.stations.every((station) => station.lineId === originalLineId())).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments.every((segment) => segment.lineId === originalLineId())).toBe(true);
    expect(result.segments.every((segment) => segment.id.startsWith('mlit-segment-'))).toBe(true);
  });

  it('splits a Y-shaped branching line into non-branching chains with distinct station ids', async () => {
    const result = await loadFixture(
      [
        stationFeature('始点', '001', 139, 35),
        stationFeature('中間', '002', 139, 35.01),
        stationFeature('分岐', '003', 139, 35.02),
        stationFeature('終点', '004', 139, 35.03),
        stationFeature('支線', '005', 139.01, 35.02),
      ],
      [
        sectionFeature([[139, 35], [139, 35.01]]),
        sectionFeature([[139, 35.01], [139, 35.02]]),
        sectionFeature([[139, 35.02], [139, 35.03]]),
        sectionFeature([[139, 35.02], [139.01, 35.02]]),
      ],
    );

    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((line) => line.id !== originalLineId())).toBe(true);
    expect(result.lines.every((line) => line.operatorName === OPERATOR)).toBe(true);
    expect(result.lines.every((line) => line.operatorId === result.lines[0].operatorId)).toBe(true);
    expect(result.lines.every((line) => /試験線（.+〜.+）/.test(line.name))).toBe(true);

    const stationIds = result.stations.map((station) => station.id);
    expect(new Set(stationIds).size).toBe(stationIds.length);

    const junctionCopies = result.stations.filter((station) => station.name === '分岐');
    expect(junctionCopies.length).toBeGreaterThan(1);
    expect(new Set(junctionCopies.map((station) => station.id)).size).toBe(junctionCopies.length);
    expect(new Set(junctionCopies.map((station) => station.lineId)).size).toBe(junctionCopies.length);

    for (const line of result.lines) {
      const lineStations = result.stations.filter((station) => station.lineId === line.id);
      const lineSegments = result.segments.filter((segment) => segment.lineId === line.id);
      expect(lineStations.length).toBeGreaterThanOrEqual(2);
      expect(lineSegments.length).toBeGreaterThanOrEqual(1);
      expect(Math.max(...uniqueNeighborCounts(lineStations, lineSegments))).toBeLessThanOrEqual(2);
      expect(lineStations.map((station) => station.sequence)).toEqual(
        lineStations.map((_, index) => index + 1),
      );
      expect(line.name).toBe(`試験線（${lineStations[0].name}〜${lineStations[lineStations.length - 1].name}）`);
    }

    expect(() => new TopologyBuilder().buildTopology(result.lines, result.stations, result.segments)).not.toThrow();
  });

  it('emits each disconnected linear component as its own line', async () => {
    const result = await loadFixture(
      [
        stationFeature('北始', '001', 139, 35),
        stationFeature('北終', '002', 139, 35.01),
        stationFeature('南始', '003', 139.3, 35),
        stationFeature('南終', '004', 139.3, 35.01),
      ],
      [
        sectionFeature([[139, 35], [139, 35.01]]),
        sectionFeature([[139.3, 35], [139.3, 35.01]]),
      ],
    );

    expect(result.lines).toHaveLength(2);
    expect(result.lines.every((line) => line.id !== originalLineId())).toBe(true);
    const namedFromEndpoints = (codeA: string, nameA: string, codeB: string, nameB: string): string => {
      const [first, last] = originalStationId(codeA) < originalStationId(codeB) ? [nameA, nameB] : [nameB, nameA];
      return `${LINE_NAME}（${first}〜${last}）`;
    };
    const names = result.lines.map((line) => line.name).sort();
    expect(names).toEqual([
      namedFromEndpoints('001', '北始', '002', '北終'),
      namedFromEndpoints('003', '南始', '004', '南終'),
    ].sort());
    expect(result.stations).toHaveLength(4);
    expect(new Set(result.stations.map((station) => station.id)).size).toBe(4);
    expect(result.segments).toHaveLength(2);
    expect(() => new TopologyBuilder().buildTopology(result.lines, result.stations, result.segments)).not.toThrow();
  });

  it('drops a chain that would have fewer than two stations or one segment', async () => {
    const isolatedOnly = await loadFixture(
      [stationFeature('孤駅', '001', 139, 35)],
      [],
    );
    expect(isolatedOnly.lines).toHaveLength(0);
    expect(isolatedOnly.stations).toHaveLength(0);
    expect(isolatedOnly.segments).toHaveLength(0);

    const branchedWithOrphan = await loadFixture(
      [
        stationFeature('始点', '001', 139, 35),
        stationFeature('分岐', '002', 139, 35.01),
        stationFeature('終点', '003', 139, 35.02),
        stationFeature('支線', '004', 139.01, 35.01),
        stationFeature('孤駅', '099', 139.5, 36),
      ],
      [
        sectionFeature([[139, 35], [139, 35.01]]),
        sectionFeature([[139, 35.01], [139, 35.02]]),
        sectionFeature([[139, 35.01], [139.01, 35.01]]),
      ],
    );
    expect(branchedWithOrphan.lines).toHaveLength(3);
    expect(branchedWithOrphan.stations.some((station) => station.name === '孤駅')).toBe(false);
    expect(branchedWithOrphan.stations.length).toBeGreaterThanOrEqual(2);
    expect(branchedWithOrphan.segments.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a simple cycle as a single line with the original name and ids', async () => {
    const result = await loadFixture(
      [
        stationFeature('環一', '001', 139, 35),
        stationFeature('環二', '002', 139, 35.01),
        stationFeature('環三', '003', 139.01, 35.005),
      ],
      [
        sectionFeature([[139, 35], [139, 35.01]]),
        sectionFeature([[139, 35.01], [139.01, 35.005]]),
        sectionFeature([[139.01, 35.005], [139, 35]]),
      ],
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].id).toBe(originalLineId());
    expect(result.lines[0].name).toBe(LINE_NAME);
    expect(result.stations).toHaveLength(3);
    expect(result.stations.map((station) => station.id).sort()).toEqual(
      ['001', '002', '003'].map(originalStationId).sort(),
    );
    expect(result.segments).toHaveLength(3);
    expect(Math.max(...uniqueNeighborCounts(result.stations, result.segments))).toBe(2);
    expect(() => new TopologyBuilder().buildTopology(result.lines, result.stations, result.segments)).not.toThrow();
  });

  it('produces identical ids and ordering across two loads of the same branching input', async () => {
    const stations = [
      stationFeature('始点', '001', 139, 35),
      stationFeature('分岐', '002', 139, 35.01),
      stationFeature('終点', '003', 139, 35.02),
      stationFeature('支線', '004', 139.01, 35.01),
    ];
    const sections = [
      sectionFeature([[139, 35], [139, 35.01]]),
      sectionFeature([[139, 35.01], [139, 35.02]]),
      sectionFeature([[139, 35.01], [139.01, 35.01]]),
    ];
    const first = await loadFixture(stations, sections);
    const second = await loadFixture(stations, sections);
    expect(identitySnapshot(first)).toEqual(identitySnapshot(second));
    expect(first.lines.length).toBeGreaterThan(1);
  });
});

