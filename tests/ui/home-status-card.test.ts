import { describe, expect, it } from 'vitest';
import { buildHomeStatusView } from '../../src/ui/home-status-card';
import type { HudStatusMode, HudViewModel } from '../../src/domain/models/hud';
import type { DatasetSyncStatus } from '../../src/infrastructure/storage/dexie-railway-database';

function model(overrides: Partial<HudViewModel> = {}): HudViewModel {
  return {
    header: { lineName: '小田急小田原線', serviceOrDirection: '上り' },
    speed: { displaySpeedKmhText: '93', unitText: 'km/h', isEstimated: false },
    segment: {
      previousStationName: '海老名',
      nextStationName: '座間',
      progressRatio: 0.4,
      distanceToNextText: '次まで 4.2km',
    },
    footer: { leftInfo: '', statusRight: 'GPS' },
    statusMode: 'GPS',
    rawFormattedText: '',
    timestampMs: 0,
    ...overrides,
  };
}

const sync = (partial: Partial<DatasetSyncStatus>): DatasetSyncStatus => ({ status: 'cloud', ...partial });

describe('buildHomeStatusView', () => {
  it('renders the initial placeholder before any model arrives', () => {
    expect(buildHomeStatusView(null)).toEqual({
      lineName: '路線判定中',
      direction: '',
      speedText: '-- km/h',
      statusText: '測位中',
      tone: 'alert',
    });
  });

  it('passes the HUD wording through unchanged', () => {
    const view = buildHomeStatusView(model());
    expect(view.lineName).toBe('小田急小田原線');
    expect(view.direction).toBe('上り');
    expect(view.speedText).toBe('93 km/h');
    expect(view.statusText).toBe('GPS');
    expect(view.tone).toBe('ok');
  });

  it('prefixes an estimated speed with ~', () => {
    const view = buildHomeStatusView(
      model({ speed: { displaySpeedKmhText: '88', unitText: 'km/h', isEstimated: true } })
    );
    expect(view.speedText).toBe('~88 km/h');
  });

  it('does not invent blanking: a degraded model keeps its speed text', () => {
    const view = buildHomeStatusView(
      model({ statusMode: 'GPS_DEGRADED', footer: { leftInfo: '', statusRight: 'GPS弱' } })
    );
    expect(view.speedText).toBe('93 km/h');
    expect(view.statusText).toBe('GPS弱');
  });

  it.each<[HudStatusMode, 'ok' | 'warn' | 'alert']>([
    ['GPS', 'ok'],
    ['GPS_DEGRADED', 'warn'],
    ['DR', 'warn'],
    ['REACQUIRING', 'warn'],
    ['UNCERTAIN', 'warn'],
    ['SPEED_UNKNOWN', 'alert'],
    ['LOST', 'alert'],
  ])('maps statusMode %s to tone %s', (statusMode, tone) => {
    expect(buildHomeStatusView(model({ statusMode })).tone).toBe(tone);
  });

  it('appends データ取得中 while downloading', () => {
    expect(buildHomeStatusView(model(), sync({ status: 'downloading' })).statusText).toBe('GPS · データ取得中');
  });

  it.each<DatasetSyncStatus>([
    sync({ status: 'error' }),
    sync({ status: 'unavailable' }),
    sync({ status: 'bundled', errorMessage: 'manifest 404' }),
  ])('appends データ取得エラー for %o', (status) => {
    expect(buildHomeStatusView(model(), status).statusText).toBe('GPS · データ取得エラー');
  });

  it.each<DatasetSyncStatus>([
    sync({ status: 'bundled' }),
    sync({ status: 'cached' }),
    sync({ status: 'cloud' }),
    sync({ status: 'cloud', errorMessage: '' }),
  ])('appends nothing for a healthy %o', (status) => {
    expect(buildHomeStatusView(model(), status).statusText).toBe('GPS');
  });

  it('appends the sync suffix to the placeholder as well', () => {
    expect(buildHomeStatusView(null, sync({ status: 'downloading' })).statusText).toBe('測位中 · データ取得中');
  });
});
