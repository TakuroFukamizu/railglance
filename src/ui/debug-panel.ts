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
    const { rawLocation, speed, match, journey, hudViewModel, timestampMs } = entry;

    let html = `
      <div class="debug-grid">
        <div class="debug-card">
          <h3>GPS 生データ</h3>
          <div>緯度/経度: ${rawLocation ? `${rawLocation.latitude.toFixed(6)}, ${rawLocation.longitude.toFixed(6)}` : 'なし'}</div>
          <div>精度(Accuracy): ${rawLocation ? `${rawLocation.accuracyMeters.toFixed(1)} m` : 'なし'}</div>
          <div>生速度: ${rawLocation && rawLocation.speedMps !== null ? `${(rawLocation.speedMps * 3.6).toFixed(1)} km/h` : 'なし'}</div>
          <div>Heading: ${rawLocation && rawLocation.headingDegrees !== null ? `${rawLocation.headingDegrees.toFixed(1)}°` : 'なし'}</div>
          <div>取得時刻: ${rawLocation ? new Date(rawLocation.timestampMs).toLocaleTimeString() : 'なし'}</div>
        </div>

        <div class="debug-card">
          <h3>速度フィルタ結果</h3>
          <div>フィルタ後速度: <strong>${speed.speedKmh !== null ? `${speed.speedKmh} km/h` : '--'}</strong></div>
          <div>ソース: ${speed.source}</div>
          <div>停車状態: ${speed.isStopped ? '静止 (Stopped)' : '移動中 (Moving)'}</div>
          <div>有効性: ${speed.isValid ? '有効' : '無効 (Stale/Outlier)'}</div>
        </div>

        <div class="debug-card">
          <h3>路線・駅推定結果</h3>
          <div>採用路線: <strong>${journey.line ? journey.line.name : '未定 (なし)'}</strong></div>
          <div>進行方向: ${journey.directionName ?? '不明'} (${journey.direction})</div>
          <div>前駅: ${journey.previousStation?.name ?? 'なし'}</div>
          <div>次駅: ${journey.nextStation?.name ?? 'なし'}</div>
          <div>次駅まで距離: ${journey.distanceToNextStationMeters !== null ? `${journey.distanceToNextStationMeters} m` : 'なし'}</div>
          <div>信頼度 (Confidence): <strong>${(journey.confidence * 100).toFixed(0)}% (${journey.confidence.toFixed(2)})</strong></div>
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
