import type { HudStatusMode, HudViewModel } from '../domain/models/hud';
import type { DatasetSyncStatus } from '../infrastructure/storage/dexie-railway-database';

export type StatusTone = 'ok' | 'warn' | 'alert';

export type HomeStatusView = {
  lineName: string;
  direction: string;
  speedText: string;
  statusText: string;
  tone: StatusTone;
};

const TONE_BY_MODE: Record<HudStatusMode, StatusTone> = {
  GPS: 'ok',
  GPS_DEGRADED: 'warn',
  DR: 'warn',
  REACQUIRING: 'warn',
  UNCERTAIN: 'warn',
  SPEED_UNKNOWN: 'alert',
  LOST: 'alert',
};

function syncSuffix(sync?: DatasetSyncStatus): string {
  if (!sync) return '';
  if (sync.status === 'downloading') return ' · データ取得中';
  if (sync.status === 'error' || sync.status === 'unavailable' || (sync.errorMessage ?? '') !== '') {
    return ' · データ取得エラー';
  }
  return '';
}

/**
 * Home card content. Wording comes straight from the HudViewModel so the phone
 * never disagrees with the glasses; only the tone and the dataset suffix are
 * decided here.
 */
export function buildHomeStatusView(model: HudViewModel | null, sync?: DatasetSyncStatus): HomeStatusView {
  if (!model) {
    return {
      lineName: '路線判定中',
      direction: '',
      speedText: '-- km/h',
      statusText: `測位中${syncSuffix(sync)}`,
      tone: 'alert',
    };
  }
  const prefix = model.speed.isEstimated ? '~' : '';
  return {
    lineName: model.header.lineName,
    direction: model.header.serviceOrDirection,
    speedText: `${prefix}${model.speed.displaySpeedKmhText} ${model.speed.unitText}`,
    statusText: `${model.footer.statusRight}${syncSuffix(sync)}`,
    tone: TONE_BY_MODE[model.statusMode],
  };
}
