import { RailwayDataState } from '../domain/railway/repository';
import { EstimationLogEntry } from '../infrastructure/logging/logger';
import { DatasetSyncStatus } from '../infrastructure/storage/dexie-railway-database';
import { escapeHtml, escapeHtmlValue } from './html';

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

    const renderSyncBadge = (status?: RailwayDataState) => {
      switch (status) {
        case 'cloud':
          return '<span style="color: #00FF00; background: #004400; padding: 2px 6px; border-radius: 4px; font-weight: bold;">✓ Ready</span>';
        case 'cached':
          return '<span style="color: #88FF88; background: #223322; padding: 2px 6px; border-radius: 4px; font-weight: bold;">Cached (Offline)</span>';
        case 'downloading':
          return '<span style="color: #FFFF00; background: #444400; padding: 2px 6px; border-radius: 4px; font-weight: bold;">⚡ Connecting...</span>';
        case 'error':
        case 'unavailable':
          return '<span style="color: #FF6666; background: #440000; padding: 2px 6px; border-radius: 4px; font-weight: bold;">✕ Error</span>';
        case 'bundled':
        default:
          return '<span style="color: #AAAAAA; background: #222222; padding: 2px 6px; border-radius: 4px;">Local Sample</span>';
      }
    };

    const html = `
      <div class="debug-grid">
        <div class="debug-card" style="border-left: 4px solid #00AAFF;">
          <h3>Cloudflare R2 On-Demand H3 Tile Status</h3>
          <div>同期ステータス: ${renderSyncBadge(datasetSyncStatus?.status)}</div>
          <div>データセットバージョン: <strong>${escapeHtmlValue(datasetSyncStatus?.version, 'v1.0.0')}</strong></div>
          <div>現在地 H3 Cell: <strong style="color: #FFDD55;">${escapeHtmlValue(datasetSyncStatus?.currentCellId, '未検出')}</strong></div>
          <div>オンデマンド取得済みタイル数: <strong>${datasetSyncStatus?.loadedTileCount ?? 0} 個</strong></div>
          <div>キャッシュ内規模: <strong>${datasetSyncStatus?.totalLines ?? 0} 路線 / ${datasetSyncStatus?.totalStations ?? 0} 駅</strong></div>
          <div>ベースURL: <small style="color: #88CCFF;">${escapeHtmlValue(datasetSyncStatus?.baseUrl, '(ローカル内蔵データ)')}</small></div>
          ${datasetSyncStatus?.errorMessage ? `<div style="color: #FF8888; font-size: 11px; margin-top: 4px;">Error: ${escapeHtml(datasetSyncStatus.errorMessage)}</div>` : ''}
        </div>

        <div class="debug-card">
          <h3>Dead Reckoning & G2 SDK Image Status</h3>
          <div>Navigation Mode: <span class="badge ${escapeHtml(navState.mode)}">${escapeHtml(navState.mode)}</span></div>
          <div>G2 PNG Update Status: <strong style="color: #00FF00; background: #000; padding: 2px 6px; border-radius: 4px;">${escapeHtmlValue(lastImageResult, 'none')}</strong></div>
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
          <div>Selected source: <span class="badge ${escapeHtml(selectedEstimate.source)}">${escapeHtml(selectedEstimate.source)}</span></div>
          <div>EMA Output: <strong>${formatSpeed(smoothedSpeedKmh)}</strong></div>
          <div>状態: ${isStopped ? '静止 (Stopped)' : '移動中'} / ${isValid ? '有効' : '無効'}</div>
        </div>

        <div class="debug-card">
          <h3>路線・駅推定結果</h3>
          <div>採用路線: <strong>${journey.line ? escapeHtml(journey.line.name) : '未定 (なし)'}</strong></div>
          <div>進行方向: ${escapeHtmlValue(journey.directionName, '不明')} (${escapeHtml(journey.direction)})</div>
          <div>前駅: ${escapeHtmlValue(journey.previousStation?.name, 'なし')}</div>
          <div>次駅: ${escapeHtmlValue(journey.nextStation?.name, 'なし')}</div>
          <div>次駅まで距離: ${journey.distanceToNextStationMeters !== null ? `${journey.distanceToNextStationMeters} m` : 'なし'}</div>
          <div>路線判定信頼度: <strong>${(journey.confidence * 100).toFixed(0)}% (${journey.confidence.toFixed(2)})</strong></div>
          <div>ステータス: <span class="badge ${escapeHtml(journey.status)}">${escapeHtml(journey.status)}</span></div>
          <div>駅データ完全性: ${journey.stationDataComplete ? '✓ 完全 (同期済み)' : '⚠ 不完全 (未確認)'}</div>
        </div>

        <div class="debug-card">
          <h3>Route Matching Reliability</h3>
          <div>Route State: <span class="badge ${escapeHtml(match?.lockState ?? 'UNRESOLVED')}">${escapeHtml(match?.lockState ?? 'UNRESOLVED')}</span></div>
          <div>Current Route: <strong>${escapeHtmlValue(match?.selectedLine.name, 'なし')}</strong></div>
          <div>Current Segment: ${escapeHtmlValue(match?.selectedSegment.id, 'なし')}</div>
          <div>Current Score: ${match?.currentScore ?? match?.candidates.find((c) => c.segment.id === match?.selectedSegment.id)?.totalScore ?? '--'}</div>
          <div>Current Score (rescored): ${match?.rescoredCurrentScore ?? '--'}</div>
          <div>Top Candidate: ${match?.candidates[0] ? `${escapeHtml(match.candidates[0].line.name)} (${match.candidates[0].totalScore})` : 'なし'}</div>
          <div>Second Candidate: ${match?.candidates[1] ? `${escapeHtml(match.candidates[1].line.name)} (${match.candidates[1].totalScore})` : 'なし'}</div>
          <div>Score Margin: <strong>${match?.scoreMargin ?? '--'}</strong></div>
          <div>Route Health: <strong>${match?.routeHealth ? match.routeHealth.total.toFixed(2) : '--'}</strong></div>
          <div>Distance Consistency: ${match?.routeHealth?.distanceConsistency ?? '--'}</div>
          <div>Heading Consistency: ${match?.routeHealth?.headingConsistency ?? '--'}</div>
          <div>Trajectory Consistency: ${match?.routeHealth?.trajectoryConsistency ?? '--'}</div>
          <div>Progress Consistency: ${match?.routeHealth?.progressConsistency ?? '--'}</div>
          <div>Station Sequence Consistency: ${match?.routeHealth?.stationSequenceConsistency ?? '--'}</div>
          <div>Challenger: ${match?.challenger ? escapeHtml(match.challenger.lineId) : 'なし'}</div>
          <div>Challenger Score: ${match?.challenger?.latestScore ?? '--'}</div>
          <div>Consecutive Wins: ${match?.challenger?.consecutiveWins ?? '--'}</div>
          <div>Duration: ${match?.challenger ? `${Math.max(0, match.challenger.lastSeenAtMs - match.challenger.firstSeenAtMs)} ms` : '--'}</div>
          <div>Trajectory Heading: ${match?.trajectoryHeadingDegrees !== null && match?.trajectoryHeadingDegrees !== undefined ? `${match.trajectoryHeadingDegrees.toFixed(1)}°` : '--'}</div>
          <div>Manual Lock State: ${match?.lockState === 'MANUAL_LOCK' ? (match.manualLockAway ? '離れている' : 'ロック中') : 'なし'}</div>
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
                      <th>履歴</th>
                      <th>合計点</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${match.candidates
                      .map(
                        (c) => `
                      <tr class="${c.segment.id === match.selectedSegment.id ? 'active-row' : ''}">
                        <td>${escapeHtml(c.line.name)}<br><small>${escapeHtml(c.segment.id)}</small></td>
                        <td>${c.distanceMeters}m</td>
                        <td>${c.distanceScore}</td>
                        <td>${c.headingScore}</td>
                        <td>${c.continuityScore}</td>
                        <td>${c.historyScore}</td>
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
