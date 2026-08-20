import { afterEach, describe, expect, it } from 'vitest';
import { DebugPanel, renderSyncBadge } from '../../src/ui/debug-panel';
import type { EstimationLogEntry } from '../../src/infrastructure/logging/logger';
import type { BridgeDiagnosticsSnapshot } from '../../src/infrastructure/even-g2/bridge-operation';
import { emptyBridgeOperationState } from '../../src/infrastructure/even-g2/bridge-operation';

describe('renderSyncBadge', () => {
  it('renders cloud as ready R2 H3 streaming', () => {
    const html = renderSyncBadge('cloud');
    expect(html).toContain('✓ Ready (R2 H3 Streaming)');
    expect(html).toContain('#00FF00');
  });

  it('renders cached as ready cached', () => {
    const html = renderSyncBadge('cached');
    expect(html).toContain('✓ Ready (Cached)');
  });

  it('renders downloading as connecting R2', () => {
    const html = renderSyncBadge('downloading');
    expect(html).toContain('⚡ Connecting R2...');
    expect(html).toContain('#FFFF00');
  });

  it('renders error as an error badge', () => {
    const html = renderSyncBadge('error');
    expect(html).toContain('✕ Error');
    expect(html).toContain('#FF6666');
  });

  it('renders unavailable as an unavailable badge', () => {
    const html = renderSyncBadge('unavailable');
    expect(html).toContain('✕ Unavailable');
    expect(html).toContain('#FF6666');
  });

  it('renders bundled as local sample', () => {
    const html = renderSyncBadge('bundled');
    expect(html).toContain('Local Sample');
    expect(html).toContain('#AAAAAA');
  });

  it('renders undefined as local sample', () => {
    const html = renderSyncBadge(undefined);
    expect(html).toContain('Local Sample');
    expect(html).toContain('#AAAAAA');
  });
});

function estimationEntry(): EstimationLogEntry {
  return {
    timestampMs: 1_700_000_000_000,
    rawLocation: null,
    speedState: {
      selectedEstimate: { speedKmh: 40, confidence: 0.8, source: 'os-geolocation', timestamp: 1_700_000_000_000 },
      smoothedSpeedKmh: 40,
      isStopped: false,
      isValid: true,
      candidates: {
        osSpeed: { speedKmh: 40, confidence: 0.8, source: 'os-geolocation', timestamp: 1_700_000_000_000 },
        positionDeltaSpeed: null,
        trackDistanceSpeed: null,
        deadReckoningSpeed: null,
        sensorFusionSpeed: null,
      },
      navState: {
        lineId: null,
        routeId: null,
        segmentId: null,
        direction: 'UP',
        trackPositionMeters: 0,
        velocityMps: 0,
        accelerationMps2: 0,
        accelerationBiasMps2: 0,
        lastObservationTimestampMs: null,
        lastPredictionTimestampMs: 1_700_000_000_000,
        mode: 'gps-locked',
        confidence: 0.8,
      },
    },
    match: null,
    journey: {
      line: null,
      direction: 'UP',
      directionName: '上り',
      previousStation: null,
      nextStation: null,
      distanceToNextStationMeters: null,
      progressRatio: null,
      stationDataComplete: true,
      confidence: 0,
      status: 'TRACKING',
    },
    hudViewModel: {
      header: { lineName: 'Test', serviceOrDirection: '上り' },
      speed: { displaySpeedKmhText: '40', unitText: 'km/h', isEstimated: false },
      segment: {
        previousStationName: 'A',
        nextStationName: 'B',
        progressRatio: 0.5,
        distanceToNextText: '1km',
      },
      footer: { leftInfo: '', statusRight: 'GPS' },
      statusMode: 'GPS',
      rawFormattedText: '',
      timestampMs: 1_700_000_000_000,
    },
  };
}

function installDocumentMock(): { innerHTML: string } {
  const container = { id: 'debug-panel', innerHTML: '' };
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => (id === 'debug-panel' ? container : null),
    createElement: () => ({ id: '', innerHTML: '' }),
    body: { appendChild: () => {} },
  };
  return container;
}

describe('DebugPanel Even G2 Bridge Transport card', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('renders placeholders when bridge diagnostics are absent', () => {
    const container = installDocumentMock();
    const panel = new DebugPanel('debug-panel');
    panel.update(estimationEntry(), 'success');

    expect(container.innerHTML).toContain('Even G2 Bridge Transport');
    expect(container.innerHTML).toContain('G2 PNG Update Status');
    expect(container.innerHTML).toContain('G2 Connection status:');
    expect(container.innerHTML).toContain('Page Ready:');
    expect(container.innerHTML).toContain('Operation Started:');
    expect(container.innerHTML).toContain('Recovery Failures:');
    expect(container.innerHTML).toMatch(/G2 Connection status: <strong>--<\/strong>/);
    expect(container.innerHTML).toMatch(/Operation Started: <strong>--<\/strong>/);
    expect(container.innerHTML).toMatch(/Recovery Failures: <strong>--<\/strong>/);
  });

  it('renders escaped diagnostics and highlights an overdue operation age', () => {
    const container = installDocumentMock();
    const panel = new DebugPanel('debug-panel');
    const bridge: BridgeDiagnosticsSnapshot = {
      status: 'STALLED',
      pageReady: false,
      sessionEpoch: 4,
      operation: {
        ...emptyBridgeOperationState(),
        currentOperation: 'speed-image',
        currentStartedAtMs: 1_700_000_000_000,
        lastCompletedOperation: 'text-header',
        lastCompletedAtMs: 1_700_000_000_000,
        lastElapsedMs: 12,
        lastResult: 'success',
        stalled: true,
      },
      operationAgeMs: 9_000,
      lastImageResult: 'success',
      lastImageCompletedAtMs: 1_700_000_000_000,
      renderGeneration: 8,
      flushedGeneration: 7,
      hudFlushScheduled: false,
      hudFlushInFlight: true,
      hudDirty: true,
      recoveryCount: 2,
      stallRecoveryFailures: 3,
      lastRecoveryReason: 'transport-stall',
      lastRecoveryAtMs: 1_700_000_000_100,
    };

    panel.update(estimationEntry(), 'success', undefined, bridge);

    expect(container.innerHTML).toContain('Even G2 Bridge Transport');
    expect(container.innerHTML).toContain('G2 PNG Update Status');
    expect(container.innerHTML).toContain('STALLED');
    expect(container.innerHTML).toContain('speed-image');
    expect(container.innerHTML).toContain('#FF6666');
    expect(container.innerHTML).toContain('9.0s');
    expect(container.innerHTML).toContain('transport-stall');
    expect(container.innerHTML).toContain('Session Epoch:');
    expect(container.innerHTML).toContain('>4<');
    expect(container.innerHTML).toContain('HUD Dirty:');
    expect(container.innerHTML).toContain('Recovery Count:');
    expect(container.innerHTML).toContain('>2<');
    expect(container.innerHTML).toContain('Recovery Failures:');
    expect(container.innerHTML).toContain('>3<');
    expect(container.innerHTML).toContain('Operation Started:');
    expect(container.innerHTML).toContain(
      new Date(1_700_000_000_000).toLocaleTimeString()
    );
  });
});
