import { describe, it, expect } from 'vitest';
import { ManualCorrectionAdapter } from '../../src/etl/adapters/manual-correction-adapter';
import { LineDirectionCorrection, resolveLineDirectionNames } from '../../src/etl/line-directions';
import { RailwayLine, Station } from '../../src/domain/models/railway';
import lineDirections from '../../data/corrections/line-directions.json';
import sampleLines from '../../src/data/sample/lines.json';
import sampleStations from '../../src/data/sample/stations.json';

const YOKOHAMA: LineDirectionCorrection = {
  lineNames: ['横浜線', 'JR横浜線'],
  operators: ['東日本旅客鉄道', 'jreast'],
  upTerminalStation: '東神奈川',
};

function station(id: string, lineId: string, name: string, sequence: number): Station {
  return { id, lineId, name, sequence, latitude: 35.5, longitude: 139.6 };
}

const mlitLine: RailwayLine = {
  id: 'mlit-line-1',
  operatorId: 'mlit-operator-1',
  operatorName: '東日本旅客鉄道',
  name: '横浜線',
};

describe('resolveLineDirectionNames', () => {
  it('assigns 上り to increasing sequence when the up terminal has the highest sequence', () => {
    const stations = [
      station('a', mlitLine.id, '八王子', 1),
      station('b', mlitLine.id, '新横浜', 2),
      station('c', mlitLine.id, '東神奈川', 3),
    ];
    expect(resolveLineDirectionNames(YOKOHAMA, stations)).toEqual({ directionAName: '上り', directionBName: '下り' });
  });

  it('assigns 下り to increasing sequence when the up terminal is sequence 1 (the MLIT 横浜線 case)', () => {
    const stations = [
      station('a', mlitLine.id, '東神奈川', 1),
      station('b', mlitLine.id, '新横浜', 2),
      station('c', mlitLine.id, '八王子', 3),
    ];
    expect(resolveLineDirectionNames(YOKOHAMA, stations)).toEqual({ directionAName: '下り', directionBName: '上り' });
  });

  it('returns null when the up terminal is missing or not at an end of the line', () => {
    const missing = [station('a', mlitLine.id, '新横浜', 1), station('b', mlitLine.id, '八王子', 2)];
    expect(resolveLineDirectionNames(YOKOHAMA, missing)).toBeNull();

    const midLine = [
      station('a', mlitLine.id, '横浜', 1),
      station('b', mlitLine.id, '東神奈川', 2),
      station('c', mlitLine.id, '八王子', 3),
    ];
    expect(resolveLineDirectionNames(YOKOHAMA, midLine)).toBeNull();
  });

  it('uses custom labels when the entry provides them', () => {
    const entry: LineDirectionCorrection = { ...YOKOHAMA, upLabel: '内回り', downLabel: '外回り' };
    const stations = [station('a', mlitLine.id, '東神奈川', 1), station('b', mlitLine.id, '八王子', 2)];
    expect(resolveLineDirectionNames(entry, stations)).toEqual({ directionAName: '外回り', directionBName: '内回り' });
  });
});

describe('ManualCorrectionAdapter line direction corrections', () => {
  const stations = [
    station('a', mlitLine.id, '東神奈川', 1),
    station('b', mlitLine.id, '新横浜', 2),
    station('c', mlitLine.id, '八王子', 3),
  ];

  it('fills in direction names for a matching line that has none', () => {
    const adapter = new ManualCorrectionAdapter({ lineDirections: [YOKOHAMA] });
    const result = adapter.applyCorrections({ lines: [mlitLine], stations, segments: [] });
    expect(result.lines[0].directionAName).toBe('下り');
    expect(result.lines[0].directionBName).toBe('上り');
    expect(result.lines[0].provenance?.some((p) => p.manuallyCorrected)).toBe(true);
  });

  it('matches chain-split line names such as 横浜線（東神奈川〜八王子）', () => {
    const adapter = new ManualCorrectionAdapter({ lineDirections: [YOKOHAMA] });
    const chainLine = { ...mlitLine, name: '横浜線（東神奈川〜八王子）' };
    const result = adapter.applyCorrections({ lines: [chainLine], stations, segments: [] });
    expect(result.lines[0].directionAName).toBe('下り');
    expect(result.lines[0].directionBName).toBe('上り');
  });

  it('requires the operator to match when the entry names operators (京急本線 vs 京成本線)', () => {
    const keikyu: LineDirectionCorrection = { lineNames: ['本線'], operators: ['京浜急行電鉄'], upTerminalStation: '泉岳寺' };
    const keisei: RailwayLine = { id: 'l-keisei', operatorId: 'op-keisei', operatorName: '京成電鉄', name: '本線' };
    const keiseiStations = [station('k1', keisei.id, '泉岳寺', 1), station('k2', keisei.id, '成田空港', 2)];
    const adapter = new ManualCorrectionAdapter({ lineDirections: [keikyu] });
    const result = adapter.applyCorrections({ lines: [keisei], stations: keiseiStations, segments: [] });
    expect(result.lines[0].directionAName).toBeUndefined();
    expect(result.lines[0].directionBName).toBeUndefined();
  });

  it('leaves existing curated direction names untouched', () => {
    const adapter = new ManualCorrectionAdapter({ lineDirections: [YOKOHAMA] });
    const named = { ...mlitLine, directionAName: '下り（八王子方面）', directionBName: '上り（東神奈川方面）' };
    const result = adapter.applyCorrections({ lines: [named], stations, segments: [] });
    expect(result.lines[0].directionAName).toBe('下り（八王子方面）');
    expect(result.lines[0].directionBName).toBe('上り（東神奈川方面）');
  });

  it('leaves the line untouched when the up terminal cannot be located', () => {
    const adapter = new ManualCorrectionAdapter({ lineDirections: [YOKOHAMA] });
    const partial = [station('b', mlitLine.id, '新横浜', 1), station('c', mlitLine.id, '八王子', 2)];
    const result = adapter.applyCorrections({ lines: [mlitLine], stations: partial, segments: [] });
    expect(result.lines[0].directionAName).toBeUndefined();
  });
});

describe('curated line-directions.json', () => {
  const entries = lineDirections.lineDirections as LineDirectionCorrection[];

  it('covers the JR横浜線 reported in issue #72', () => {
    const entry = entries.find((e) => e.lineNames.includes('横浜線'));
    expect(entry?.upTerminalStation).toBe('東神奈川');
    expect(entry?.operators).toContain('東日本旅客鉄道');
  });

  it('agrees with the bundled sample lines: directionAName must describe travel toward increasing sequence', () => {
    const adapter = new ManualCorrectionAdapter({ lineDirections: entries });
    const lines = sampleLines as RailwayLine[];
    const stations = sampleStations as Station[];
    const checked: string[] = [];
    for (const line of lines) {
      const entry = entries.find((candidate) => adapter.matchesLineDirection(candidate, line));
      if (!entry) continue;
      const expected = resolveLineDirectionNames(entry, stations.filter((s) => s.lineId === line.id));
      expect(expected, `${line.id}: up terminal ${entry.upTerminalStation} must be at an end of the sample line`).not.toBeNull();
      expect(line.directionAName, `${line.id} directionAName`).toMatch(new RegExp(`^${expected!.directionAName}`));
      expect(line.directionBName, `${line.id} directionBName`).toMatch(new RegExp(`^${expected!.directionBName}`));
      checked.push(line.id);
    }
    expect(checked).toContain('jreast-yokohama-line');
    expect(checked).toContain('odakyu-odawara');
  });
});
