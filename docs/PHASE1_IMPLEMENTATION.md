# Phase 1 実装仕様

## 1. 概要

Phase 1では、スマートフォンのGPSとクライアント内の静的鉄道データだけを使って、Even G2に列車移動情報を表示します。ネットワーク接続は使用しません。

## 2. ユースケース

利用者が電車に乗り、プラグインを起動すると、数秒から数十秒の観測後に次を表示します。

- 現在速度
- 推定路線
- 推定方向
- 前駅
- 次駅
- 次駅までの距離

## 3. 状態遷移

```text
INITIALIZING
    ↓
WAITING_FOR_GPS
    ↓
MATCHING_ROUTE
    ↓
TRACKING
```

例外状態:

```text
GPS_UNAVAILABLE
GPS_LOW_ACCURACY
ROUTE_UNCERTAIN
DATASET_UNAVAILABLE
```

## 4. GPS処理

```ts
type LocationSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMps: number | null;
  headingDegrees: number | null;
  timestampMs: number;
};
```

採用条件:

- accuracyが設定値以下
- timestampが古すぎない
- 緯度経度が有効
- 前サンプルとの時間差が正
- 推定速度が上限以下
- 瞬間的な移動が非現実的でない

`coords.speed` が有効な場合は優先利用し、無効な場合は位置差分と時間差から算出します。

```text
speedMps = distanceMeters / elapsedSeconds
speedKmh = speedMps × 3.6
```

表示用速度はEMA等で平滑化します。

## 5. 路線推定

現在位置から一定半径内の線路セグメントを抽出します。

初期値:

```text
探索半径: 500m
候補上限: 20
```

候補スコア例:

```text
score =
  distanceScore
  + headingScore
  + continuityScore
  + accuracyScore
  + historyScore
```

別候補が一時的に上位になっても即時切替しません。

推奨条件:

- 新候補が3回連続で優勢
- または5秒以上優勢
- 現候補とのスコア差が一定以上

## 6. 方向推定

線路セグメントのポリライン方向と、GPS移動方向を比較して推定します。低速時はheadingが不安定になるため、過去数秒の位置移動ベクトルを優先します。

## 7. 駅推定

選択されたセグメントと方向から、前駅・次駅を決定します。駅順序は `sequence` により管理します。

## 8. 次駅までの距離

可能な限り次の合計で計算します。

```text
現在地から現在セグメント終端まで
+
途中セグメント長
+
次駅まで
```

MVPでは現在セグメントが駅間を表す前提でも構いません。

## 9. 信頼度

信頼度は0.0〜1.0で表現します。

```text
0.80以上: 確定表示
0.55以上: 推定表示
0.55未満: 路線判定中
```

## 10. HUD更新

- 更新周期: 1秒
- 変化がない場合は再描画を抑制してよい
- GPSイベント頻度とHUD描画頻度を分離する
- 数値のちらつきを防ぐ

## 11. データセット

Phase 1では小規模な対象路線データを同梱します。

最低限:

```text
路線 1本
駅 5駅以上
駅間セグメント
方向名
```

データセットは手作業でも構いませんが、生成手順を文書化してください。

## 12. エラーハンドリング

### GPS拒否

```text
位置情報が無効です
スマートフォンで許可してください
```

### GPSタイムアウト

```text
GPS信号待機中
```

### 路線データなし

```text
対象路線外
```

### トンネル

最後の有効値を短時間保持した後、GPS不明状態へ移行します。最後の速度を長時間表示し続けないでください。

## 13. ログ

```ts
{
  timestamp,
  rawLocation,
  filteredSpeed,
  routeCandidates,
  selectedRoute,
  selectedSegment,
  confidence,
  previousStation,
  nextStation,
  distanceToNextStation
}
```

## 14. 設定値

```ts
type TrackingConfig = {
  maxGpsAccuracyMeters: number;
  routeSearchRadiusMeters: number;
  maxSpeedKmh: number;
  stopThresholdKmh: number;
  stopDurationMs: number;
  staleLocationMs: number;
  hudRefreshMs: number;
  emaAlpha: number;
  routeSwitchConsecutiveCount: number;
  routeSwitchMinimumMs: number;
};
```

## 15. 受け入れ試験

### 静止

- 速度が0km/hへ収束する
- GPSドリフトで数km/hを出し続けない

### 徒歩・車移動

- 速度表示が破綻しない
- 対象線路外では路線断定しない

### 対象路線乗車

- 路線名が安定して表示される
- 進行方向が正しい
- 前駅・次駅が正しい
- 駅通過後に表示が更新される
- 並走区間で頻繁に切り替わらない

### GPS不良

- トンネルで誤った0km/hへ即時変化しない
- 一定時間後にGPS不明表示となる
