import { EstimationLogEntry } from '../infrastructure/logging/logger';
import { DatasetSyncStatus } from '../infrastructure/storage/dexie-railway-database';

export class DebugPanel {
  private container: HTMLElement;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) {
      this.container = document.createElement('div');
      this.container.id = containerId;
      document.body.appendChild(this.container);
    } else {
      this.container = el;
    }
  }

  public update(
    entry: EstimationLogEntry,
    lastImageResult?: string,
    datasetSyncStatus?: DatasetSyncStatus
  ): void {
    const { rawLocation, speedState, match, journey, timestampMs } = entry;
    const { selectedEstimate, smoothedSpeedKmh, isStopped, isValid, candidates, navState } = speedState;

    const formatSpeed = (val: number | null | undefined) =>
      val !== null && val !== undefined ? `${val.toFixed(1)} km/h` : '--';

    const gpsAgeMs = rawLocation ? timestampMs - rawLocation.timestampMs : 'N/A';

    const renderSyncBadge = (status?: string) => {
      switch (status) {
        case 'READY_R2':
          return '<span style="color: #00FF00; background: #004400; padding: 2px 6px; border-radius: 4px; font-weight: bold;">✓ Ready (R2 CDN)</span>';
        case 'SYNCING':
          return '<span style="color: #FFFF00; background: #444400; padding: 2px 6px; border-radius: 4px; font-weight: bold;">⚡ Syncing...</span>';
        case 'ERROR':
          return '<span style="color: #FF6666; background: #440000; padding: 2px 6px; border-radius: 4px; font-weight: bold;">✕ Error</span>';
        case 'LOCAL_SAMPLE':
        default:
          return '<span style="color: #AAAAAA; background: #222222; padding: 2px 6px; border-radius: 4px;">Local Sample</span>';
      }
    };

    let html = `
      <div class="debug-grid">
        <div class="debug-card" style="border-left: 4px solid #00AAFF;">
          <h3>Cloudflare R2 データセット同期状況</h3>
          <div>同期ステータス: ${renderSyncBadge(datasetSyncStatus?.status)}</div>
          <div>データセットバージョン: <strong>${datasetSyncStatus?.version ?? 'v1.0.0'}</strong></div>
          <div>ベースURL: <small style="color: #88CCFF;">${datasetSyncStatus?.baseUrl ?? '(ローカル内蔵データ)'}</small></div>
          <div>収録規模: <strong>${datasetSyncStatus?.totalLines ?? 62} 路線 / ${datasetSyncStatus?.totalStations ?? 66} 駅</strong></div>
          ${datasetSyncStatus?.errorMessage ? `<div style="color: #FF8888; font-size: 11px; margin-top: 4px;">Error: ${datasetSyncStatus.errorMessage}</div>` : ''}
        </div>

        <div class="debug-card">
          <h3>Dead Reckoning & G2 SDK Image Status</h3>
          <div>Navigation Mode: <span class="badge ${navState.mode}">${navState.mode}</span></div>
          <div>G2 PNG Update Status: <strong style="color: #00FF00; background: #000; padding: 2px 6px; border-radius: 4px;">${lastImageResult ?? 'none'}</strong></div>
          <div>GPS Age: <strong>${typeof gpsAgeMs === 'number' ? `${gpsAgeMs} ms` : gpsAgeMs}</strong></div>
          <div>Track Position: ${navState.trackPositionMeters !== null ? `${navState.trackPositionMeters.toFixed(1)} m` : '未測定'}</div>
          <div>Predicted Speed (1D): ${formatSpeed(navState.velocityMps * 3.6)}</div>
          <div>Acceleration: ${navState.accelerationMps2.toFixed(3)} m/s²</div>
          <div>Overall Confidence: <strong>${(navState.confidence * 100).toFixed(0)}% (${navState.confidence.toFixed(2)})</strong></div>
        </div>

        <div class="debug-card">
          <h3>マルチソース速度比較</h3>
          <div>Raw GPS speed: ${formatSpeed(candidates.osSpeed?.speedKmh)} (conf: ${candidates.osSpeed?.confidence ?? 0})</div>
          <div>Position Delta speed: ${formatSpeed(candidates.positionDeltaSpeed?.speedKmh)} (conf: ${candidates.positionDeltaSpeed?.confidence ?? 0})</div>
          <div>Track Distance speed: ${formatSpeed(candidates.trackDistanceSpeed?.speedKmh)} (conf: ${candidates.trackDistanceSpeed?.confidence ?? 0})</div>
          <div>Dead Reckoning speed: ${formatSpeed(candidates.deadReckoningSpeed?.speedKmh)} (conf: ${candidates.deadReckoningSpeed?.confidence ?? 0})</div>
          <div style="margin-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 4px;">
            Selected speed: <strong>${formatSpeed(selectedEstimate.speedKmh)}</strong>
          </div>
          <div>Selected source: <span class="badge ${selectedEstimate.source}">${selectedEstimate.source}</span></div>
          <div>EMA Output: <strong>${formatSpeed(smoothedSpeedKmh)}</strong></div>
          <div>状態: ${isStopped ? '静止 (Stopped)' : '移動中'} / ${isValid ? '有効' : '無効'}</div>
        </div>

        <div class="debug-card">
          <h3>路線・駅推定結果</h3>
          <div>採用路線: <strong>${journey.line ? journey.line.name : '未定 (なし)'}</strong></div>
          <div>進行方向: ${journey.directionName ?? '不明'} (${journey.direction})</div>
          <div>前駅: ${journey.previousStation?.name ?? 'なし'}</div>
          <div>次駅: ${journey.nextStation?.name ?? 'なし'}</div>
          <div>次駅まで距離: ${journey.distanceToNextStationMeters !== null ? `${journey.distanceToNextStationMeters} m` : 'なし'}</div>
          <div>路線判定信頼度: <strong>${(journey.confidence * 100).toFixed(0)}% (${journey.confidence.toFixed(2)})</strong></div>
          <div>ステータス: <span class="badge ${journey.status}">${journey.status}</span></div>
        </div>

        <div class="debug-card candidates-card">
          <h3>候補路線・セグメント スコア内訳</h3>
          ${
            match && match.candidates.length > 0
              ? `<table class="candidate-table">
                  <thead>
                    <tr>
                      <th>路線 / セグメント</th>
                      <th>距離(m)</th>
                      <th>距離点</th>
                      <th>Heading点</th>
                      <th>連続性</th>
                      <th>合計点</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${match.candidates
                      .map(
                        (c) => `
                      <tr class="${c.segment.id === match.selectedSegment.id ? 'active-row' : ''}">
                        <td>${c.line.name}<br><small>${c.segment.id}</small></td>
                        <td>${c.distanceMeters}m</td>
                        <td>${c.distanceScore}</td>
                        <td>${c.headingScore}</td>
                        <td>${c.continuityScore}</td>
                        <td><strong>${c.totalScore}</strong></td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>`
              : '<div>候補なし</div>'
          }
        </div>
      </div>
      <div class="debug-footer">最終更新: ${new Date(timestampMs).toLocaleTimeString()}</div>
    `;

    this.container.innerHTML = html;
  }
}
