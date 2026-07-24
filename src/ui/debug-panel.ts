import { EstimationLogEntry } from '../infrastructure/logging/logger';

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

  public update(entry: EstimationLogEntry): void {
    const { rawLocation, speedState, match, journey, timestampMs } = entry;
    const { selectedEstimate, smoothedSpeedKmh, isStopped, isValid, candidates } = speedState;

    const formatSpeed = (val: number | null | undefined) =>
      val !== null && val !== undefined ? `${val.toFixed(1)} km/h` : '--';

    let html = `
      <div class="debug-grid">
        <div class="debug-card">
          <h3>GPS 生データ & 精度</h3>
          <div>緯度/経度: ${rawLocation ? `${rawLocation.latitude.toFixed(6)}, ${rawLocation.longitude.toFixed(6)}` : 'なし'}</div>
          <div>GPS Accuracy: <strong>${rawLocation ? `${rawLocation.accuracyMeters.toFixed(1)} m` : 'なし'}</strong></div>
          <div>生OS速度: ${rawLocation && rawLocation.speedMps !== null ? `${(rawLocation.speedMps * 3.6).toFixed(1)} km/h` : 'なし'}</div>
          <div>Heading: ${rawLocation && rawLocation.headingDegrees !== null ? `${rawLocation.headingDegrees.toFixed(1)}°` : 'なし'}</div>
          <div>取得時刻: ${rawLocation ? new Date(rawLocation.timestampMs).toLocaleTimeString() : 'なし'}</div>
        </div>

        <div class="debug-card">
          <h3>多重速度ソース比較</h3>
          <div>Raw GPS speed: ${formatSpeed(candidates.osSpeed?.speedKmh)} (conf: ${candidates.osSpeed?.confidence ?? 0})</div>
          <div>Position Delta speed: ${formatSpeed(candidates.positionDeltaSpeed?.speedKmh)} (conf: ${candidates.positionDeltaSpeed?.confidence ?? 0})</div>
          <div>Track Distance speed: ${formatSpeed(candidates.trackDistanceSpeed?.speedKmh)} (conf: ${candidates.trackDistanceSpeed?.confidence ?? 0})</div>
          <div style="margin-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 4px;">
            Selected speed: <strong>${formatSpeed(selectedEstimate.speedKmh)}</strong>
          </div>
          <div>Selected source: <span class="badge ${selectedEstimate.source}">${selectedEstimate.source}</span></div>
          <div>Confidence: <strong>${(selectedEstimate.confidence * 100).toFixed(0)}% (${selectedEstimate.confidence.toFixed(2)})</strong></div>
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
