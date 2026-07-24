import { describe, it, expect } from 'vitest';
import { DefaultSpeedSelector } from '../../src/domain/speed/speed-selector';
import { SpeedEstimate } from '../../src/domain/models/location';

describe('SpeedSelector', () => {
  const selector = new DefaultSpeedSelector();

  it('selects os-geolocation speed when present with high confidence', () => {
    const os: SpeedEstimate = { speedKmh: 90, confidence: 0.9, source: 'os-geolocation', timestamp: 1000 };
    const delta: SpeedEstimate = { speedKmh: 88, confidence: 0.7, source: 'position-delta', timestamp: 1000 };

    const selected = selector.select([os, delta]);
    expect(selected.source).toBe('os-geolocation');
    expect(selected.speedKmh).toBe(90);
  });

  it('selects track-distance speed when OS speed is unavailable or low confidence', () => {
    const track: SpeedEstimate = { speedKmh: 85, confidence: 0.85, source: 'track-distance', timestamp: 1000 };
    const delta: SpeedEstimate = { speedKmh: 80, confidence: 0.7, source: 'position-delta', timestamp: 1000 };

    const selected = selector.select([track, delta]);
    expect(selected.source).toBe('track-distance');
    expect(selected.speedKmh).toBe(85);
  });

  it('selects position-delta speed when track-distance is unavailable', () => {
    const delta: SpeedEstimate = { speedKmh: 80, confidence: 0.7, source: 'position-delta', timestamp: 1000 };

    const selected = selector.select([delta]);
    expect(selected.source).toBe('position-delta');
    expect(selected.speedKmh).toBe(80);
  });

  it('returns unknown when no valid candidates exist', () => {
    const selected = selector.select([]);
    expect(selected.source).toBe('unknown');
    expect(selected.speedKmh).toBeNull();
  });
});
