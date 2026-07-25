# Phase 1追加要件

# Track-Constrained Dead Reckoning

## 1. 目的

本要件は、Even G2向け鉄道速度表示プラグインにおいて、GPSの更新停止や測位精度低下が発生した場合でも、速度・線路上位置・駅情報の表示を自然に継続するための追加仕様を定義する。

対象となる状況は以下とする。

* GPS更新が数秒途切れる
* トンネルや地下区間に入る
* 高架下やビル街でGPS精度が低下する
* GPS速度が一時的に`null`になる
* GPS位置が大きく跳ぶ
* GPS復帰時に実測値と推定値に差がある
* スマートフォンがポケットや鞄の中にある
* スマートフォンの向きや姿勢が途中で変わる

本機能では、完全な自由空間上の自律航法ではなく、列車が特定された線路上を移動するという制約を利用した、線路拘束型デッドレコニングを実装する。

---

## 2. 基本方針

位置と速度は、GPSイベントが発生した時だけ更新してはならない。

処理を以下の2系統へ分離すること。

### 観測更新

外部入力を受信した時に状態を補正する。

入力例：

* GPS位置
* GPS速度
* GPS精度
* GPS方位
* DeviceMotion
* DeviceOrientation
* マップマッチ結果

### 予測更新

一定周期で現在状態を未来へ進める。

推奨周期：

```text
100〜250ms
```

HUDへの送信周期は別途制御し、推奨値を以下とする。

```text
250〜1000ms
```

内部状態の更新頻度とEven G2への描画頻度を分離すること。

---

## 3. 線路上の1次元状態

列車位置は、緯度・経度だけではなく、線路上の距離として管理する。

```ts
interface TrackNavigationState {
  lineId: string | null;
  routeId: string | null;
  segmentId: string | null;
  direction: "forward" | "backward" | "unknown";

  trackPositionMeters: number | null;
  velocityMps: number;
  accelerationMps2: number;

  accelerationBiasMps2: number;

  lastObservationTimestampMs: number | null;
  lastPredictionTimestampMs: number;

  mode: NavigationMode;
  confidence: number;
}
```

`trackPositionMeters`は、対象路線または対象経路の基準点からの累積距離とする。

マップマッチ後の現在位置は、必ず線路ポリライン上へ射影し、線路上距離へ変換する。

---

## 4. NavigationMode

以下の状態を持つこと。

```ts
type NavigationMode =
  | "gps-locked"
  | "gps-degraded"
  | "dead-reckoning"
  | "dead-reckoning-low-confidence"
  | "reacquiring"
  | "lost";
```

### gps-locked

GPS精度が良好で、位置・速度ともに信頼できる状態。

### gps-degraded

GPSは取得できているが、精度低下、速度欠落、位置ジャンプなどが発生している状態。

### dead-reckoning

GPS観測が途絶しているが、直前の状態から継続推定できている状態。

### dead-reckoning-low-confidence

GPS途絶が長く、推定誤差が増大している状態。

### reacquiring

GPS復帰後、推定状態とGPS観測を滑らかに同期している状態。

### lost

路線、方向、速度、位置を妥当に推定できない状態。

---

## 5. デッドレコニングの最低実装

DeviceMotionを利用できない場合でも、以下を実装すること。

### 5.1 速度予測

```ts
predictedVelocity =
  previousVelocity +
  previousAcceleration * deltaTimeSeconds;
```

速度は負値にならないようにする。

```ts
predictedVelocity = Math.max(0, predictedVelocity);
```

現実的でない上限値を設定すること。

例：

```ts
const MAX_TRAIN_SPEED_MPS = 100;
```

値は設定ファイルで変更可能にする。

### 5.2 線路上位置予測

```ts
predictedTrackPosition =
  previousTrackPosition +
  predictedVelocity * deltaTimeSeconds;
```

加速度も含める場合は、以下を利用してよい。

```ts
predictedTrackPosition =
  previousTrackPosition +
  previousVelocity * deltaTimeSeconds +
  0.5 * previousAcceleration * deltaTimeSeconds ** 2;
```

### 5.3 加速度の減衰

GPS途絶前の加速度を無期限に維持してはならない。

```ts
decayedAcceleration =
  previousAcceleration *
  Math.exp(-deltaTimeSeconds / accelerationDecaySeconds);
```

推奨初期値：

```text
accelerationDecaySeconds = 3〜8秒
```

### 5.4 速度保持

GPS途絶直後は、最後に信頼できた速度を急激に0へ落とさないこと。

推奨挙動：

```text
0〜3秒
直前の加減速傾向を維持

3〜15秒
ほぼ定速として予測

15〜30秒
信頼度を段階的に低下

30秒以降
低信頼モードへ移行
```

時間は設定可能にすること。

---

## 6. GPS観測の有効性判定

GPSイベントを受信しても、常に採用してはならない。

以下を評価すること。

* `coords.accuracy`
* `coords.speed`
* 観測時刻
* 前回位置からの距離
* 前回速度との差
* 線路からの距離
* 現在の候補路線との整合性
* 進行方向との整合性

GPS観測を以下に分類すること。

```ts
type ObservationQuality =
  | "good"
  | "degraded"
  | "outlier"
  | "invalid";
```

### outlierの例

* 1秒で数百m移動している
* 現在路線から大きく外れている
* 速度が非現実的
* 前回状態との不連続が大きすぎる
* タイムスタンプが古い

外れ値は状態推定へ直接適用しないこと。

---

## 7. GPS途絶判定

単にイベントが来ていないかだけでなく、最終観測からの経過時間で判定する。

```ts
gpsAgeMs = nowMs - lastGpsTimestampMs;
```

推奨初期値：

```text
0〜2秒
gps-lockedまたはgps-degraded

2〜5秒
gps-degraded

5〜20秒
dead-reckoning

20〜60秒
dead-reckoning-low-confidence

60秒以上
lost候補
```

路線や環境に応じて変更可能にする。

GPSイベントが来ていても精度が著しく悪い場合は、実質的なGPS途絶として扱ってよい。

---

## 8. 信頼度

推定状態には`0.0〜1.0`の信頼度を持たせること。

信頼度へ反映する要素：

* GPS最終受信からの時間
* 最終GPS精度
* 路線特定信頼度
* 方向特定信頼度
* 速度候補間の一致度
* DeviceMotionの利用可否
* 端末操作検出
* GPS復帰時の位置誤差
* 駅位置との整合性

例：

```ts
confidence =
  gpsFreshnessScore *
  routeConfidence *
  speedConsistencyScore *
  motionReliabilityScore;
```

単純な積でなくてもよいが、各要素をデバッグ画面で確認できるようにすること。

---

## 9. DeviceMotionの利用

DeviceMotionは必須ではなく、利用可能な場合の補助入力とする。

以下を実機で確認すること。

* `DeviceMotionEvent`が存在するか
* `requestPermission()`が必要か
* EvenアプリのWebViewで権限要求できるか
* `devicemotion`イベントが発火するか
* `acceleration`が取得できるか
* `accelerationIncludingGravity`のみ取得できるか
* `rotationRate`が取得できるか
* バックグラウンド時も更新されるか

取得できない場合でも、GPSと線路拘束型予測のみで動作すること。

---

## 10. モーション権限UI

iOSでは、ユーザー操作を起点として権限要求すること。

例：

```ts
async function requestMotionPermission(): Promise<boolean> {
  const MotionEventClass =
    DeviceMotionEvent as typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };

  if (!MotionEventClass.requestPermission) {
    return true;
  }

  const result = await MotionEventClass.requestPermission();

  return result === "granted";
}
```

起動時に自動で要求せず、スマートフォン画面に以下の操作を用意する。

```text
モーションセンサーを有効化
```

権限拒否後もアプリを継続利用できること。

---

## 11. 加速度処理

スマートフォンのローカル座標を、そのまま列車の進行方向として扱ってはならない。

必要な処理：

1. 重力成分の除去
2. 端末姿勢の推定
3. 端末座標から地球座標への変換
4. 線路接線方向への射影
5. ノイズ除去
6. バイアス補正
7. 端末操作時の無効化

線路方向の単位ベクトルを`trackTangent`、地球座標系の加速度を`worldAcceleration`とした場合、線路方向加速度を以下で求める。

```ts
trackAcceleration =
  dot(worldAcceleration, trackTangent);
```

---

## 12. 端末操作検出

スマートフォンが手に持たれた、回転した、鞄へ移されたなどの操作中は、加速度を列車運動として扱わないこと。

以下を用いて端末操作を検出する。

* 大きな回転速度
* 端末姿勢の急変
* 3軸加速度の急激な変動
* 短時間の不自然な高周波振動

端末操作中は以下を行う。

```text
DeviceMotionの重みを0へ近づける
GPS速度を優先
線路上予測へ退避
信頼度を低下
```

端末が安定した後、数秒かけてDeviceMotionの重みを戻すこと。

---

## 13. 加速度バイアス

加速度センサーにはバイアスがあるため、そのまま積分してはならない。

GPSが良好な区間で、GPS速度変化とモーション加速度との差からバイアスを推定する。

```ts
estimatedBias =
  lowPassFilter(
    measuredAcceleration -
    gpsDerivedAcceleration
  );
```

GPS途絶中は、補正済み加速度を使用する。

```ts
correctedAcceleration =
  measuredAcceleration -
  estimatedBias;
```

---

## 14. 停車判定

GPS途絶中の停車判定は、加速度だけに依存してはならない。

以下を組み合わせる。

* 直前に減速が観測された
* 推定速度が低下している
* 車体振動相当のモーション量が減少した
* 駅位置へ近づいている
* 駅間距離と整合している
* 前駅通過からの経過時間
* 推定位置がホーム区間にある

Phase 1では以下の条件を初期実装とする。

```text
減速を観測
かつ
推定速度が5km/h未満
かつ
駅位置から一定距離以内
```

条件成立時は、速度を滑らかに0へ収束させる。

駅以外での信号停車は完全には特定できないため、駅位置条件を満たさなくても強い減速と低振動が続く場合は、低信頼停車として扱ってよい。

---

## 15. 駅・線路による拘束

推定位置が駅順序や線路接続関係に反して進まないようにする。

禁止例：

* 次駅を飛び越えて前駅側へ戻る
* 接続していない路線へ突然移る
* 現在方向と逆向きへ大きく進む
* 路線終端を越えて進み続ける

分岐地点では、GPS途絶前に選択されていた経路を維持する。

分岐後の路線が確定できない場合は、候補を複数保持できる設計としてもよい。

---

## 16. GPS復帰時の再同期

GPS復帰時に、表示位置と速度を即座に実測値へ飛ばしてはならない。

推定状態とGPS観測との差を計算する。

```ts
positionErrorMeters =
  gpsTrackPositionMeters -
  estimatedTrackPositionMeters;

velocityErrorMps =
  gpsVelocityMps -
  estimatedVelocityMps;
```

誤差に応じて処理を分ける。

### 小さい誤差

数秒かけて徐々に補正する。

### 中程度の誤差

GPSの重みを上げながら補正する。

### 大きい誤差

* 路線を再評価
* 方向を再評価
* `reacquiring`へ移行
* HUD上で再測位状態を示す
* 一定回数のGPS観測が安定してから確定する

補正例：

```ts
correctedValue =
  predictedValue * (1 - correctionWeight) +
  observedValue * correctionWeight;
```

`correctionWeight`は時間と観測品質に応じて変化させる。

---

## 17. 状態推定器

状態推定処理をUIやGPS取得処理から分離する。

```ts
interface NavigationStateEstimator {
  predict(nowMs: number): TrackNavigationState;

  updateWithGps(
    observation: GpsObservation
  ): TrackNavigationState;

  updateWithMotion(
    observation: MotionObservation
  ): TrackNavigationState;

  reset(reason: string): void;
}
```

実装候補：

* α-βフィルター
* α-β-γフィルター
* 1次元Kalman Filter

Phase 1では、実装とデバッグが容易な方法を採用すること。

Extended Kalman FilterやParticle Filterは、必要性を計測してから導入する。

---

## 18. 速度ソース

既存の速度ソースへ以下を追加する。

```ts
type SpeedSource =
  | "os-geolocation"
  | "position-delta"
  | "track-distance"
  | "dead-reckoning"
  | "motion-fusion"
  | "reacquired-gps"
  | "unknown";
```

速度推定結果には、必ずソースを含める。

```ts
interface SpeedEstimate {
  speedKmh: number | null;
  confidence: number;
  source: SpeedSource;
  timestamp: number;
  estimated: boolean;
}
```

---

## 19. HUD表示

HUDには原則として採用速度のみを表示する。

GPS途絶中は、推定値であることを小さく示す。

例：

```text
82 km/h  ~
```

または：

```text
82 km/h
DR
```

低信頼状態では、速度の断定表示を避けてもよい。

例：

```text
約 80 km/h
```

または：

```text
-- km/h
測位中
```

表示方針は設定可能にする。

---

## 20. デバッグ画面

スマートフォン側に以下を表示する。

```text
Navigation mode
GPS age
GPS accuracy

Raw GPS speed
Position delta speed
Track distance speed
Dead reckoning speed
Motion fusion speed
Selected speed
Selected source

Track position
Predicted track position
GPS track position
Position correction error

Acceleration
Corrected acceleration
Acceleration bias
Motion sensor weight

Route confidence
Direction confidence
Speed confidence
Overall confidence

Last observation time
Last prediction time
Last HUD update time
```

GPS、モーション、推定、補正イベントを時系列で確認できること。

---

## 21. ログ記録

以下を記録する。

```ts
interface NavigationDebugRecord {
  timestampMs: number;

  gps?: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    speedMps: number | null;
    headingDegrees: number | null;
  };

  motion?: {
    accelerationX: number | null;
    accelerationY: number | null;
    accelerationZ: number | null;
    rotationAlpha: number | null;
    rotationBeta: number | null;
    rotationGamma: number | null;
  };

  navigation: {
    mode: NavigationMode;
    trackPositionMeters: number | null;
    velocityMps: number;
    accelerationMps2: number;
    confidence: number;
  };

  selectedSpeedSource: SpeedSource;
}
```

IndexedDBへ保存し、JSONとして出力できること。

---

## 22. ログ再生

保存した実走ログを使い、GPS欠落を人工的に再現できるようにする。

機能：

* 1倍再生
* 5倍再生
* 10倍再生
* 指定区間のGPS削除
* GPS精度の劣化
* GPS位置ジャンプの注入
* DeviceMotionの無効化
* GPS復帰位置のずれ注入

同じログを使って、変更前後の推定結果を比較できること。

---

## 23. Web Worker

以下の処理は、UIスレッドから分離できる設計にする。

* 空間検索
* ポリライン射影
* 候補路線評価
* マップマッチング
* 状態推定
* ログ高速再生

Phase 1の初期実装ではメインスレッドでもよいが、インターフェース境界を明確にする。

---

## 24. WASM方針

Phase 1では、WASM採用を必須としない。

まずTypeScriptで実装し、以下を計測する。

* GPS観測1件あたりの処理時間
* マップマッチング処理時間
* 状態推定処理時間
* 候補線路数
* HUD更新遅延
* ログ10倍再生時のCPU負荷
* メインスレッドのブロック時間

WASM化の候補：

* R-treeなどの空間インデックス
* 大量ポリラインへの射影
* Hidden Markov Model
* Particle Filter
* 大量ログの高速再生
* Rust製地理演算ライブラリ

WASM化する場合も、Even SDK、UI、権限処理、IndexedDB、GPS取得はTypeScript側へ残す。

推奨境界：

```text
TypeScript
  - Even SDK
  - UI
  - Geolocation
  - DeviceMotion
  - IndexedDB
  - 状態管理

Web Worker / WASM
  - Spatial Index
  - Polyline Projection
  - Map Matching
  - Dead Reckoning
  - Filtering
```

JavaScriptとWASM間で、1件ずつ細かく呼び出してはならない。

TypedArrayなどを使用し、複数候補や履歴をまとめて渡す。

---

## 25. 性能目標

初期目標：

```text
通常の状態推定処理
10ms未満

近傍線路検索とマップマッチング
50ms未満

HUD更新
1秒以内

GPS途絶後の推定開始
1秒以内
```

処理時間はデバッグ画面へ表示する。

---

## 26. 設定項目

以下を設定ファイルへ分離する。

```ts
interface DeadReckoningConfig {
  predictionIntervalMs: number;
  hudUpdateIntervalMs: number;

  gpsDegradedAfterMs: number;
  deadReckoningAfterMs: number;
  lowConfidenceAfterMs: number;
  lostAfterMs: number;

  accelerationDecaySeconds: number;
  maximumVelocityMps: number;
  maximumAccelerationMps2: number;

  gpsCorrectionDurationMs: number;
  maximumSmoothCorrectionMeters: number;

  stationStopDistanceMeters: number;
  stationStopSpeedThresholdMps: number;

  motionPermissionEnabled: boolean;
  motionFusionEnabled: boolean;
}
```

---

## 27. テスト要件

### 単体テスト

* GPS途絶後も予測更新が継続する
* 最後の速度が即座に0にならない
* 加速度が時間とともに減衰する
* 線路上位置が速度に応じて進む
* 推定速度が負値にならない
* 異常なGPS位置を棄却する
* GPS復帰時に滑らかに補正する
* 大きな誤差で再測位状態へ移行する
* DeviceMotionがなくても動作する
* 端末操作中にモーションの重みが低下する
* 駅付近で停車へ収束する
* 信頼度がGPS経過時間に応じて低下する

### シナリオテスト

#### 短時間GPS欠落

```text
60km/hで走行
GPSが3秒欠落
GPS復帰
```

速度表示が停止せず、復帰時に大きくジャンプしないこと。

#### 中時間GPS欠落

```text
80km/hで走行
GPSが20秒欠落
直前は定速
```

推定速度と位置を継続し、信頼度が低下すること。

#### トンネル内減速

```text
GPS途絶後に減速
駅へ接近
停車
```

DeviceMotionが利用可能な場合、速度が徐々に低下すること。

#### GPS復帰位置ずれ

```text
推定位置とGPS位置に300mの差
```

即座にジャンプせず、再測位状態へ移行すること。

#### 端末持ち替え

```text
走行中にスマートフォンを回転
```

端末操作を列車加速度として積分しないこと。

#### 並走路線

```text
GPS途絶直前に複数路線が並走
```

確定済み路線を無条件に切り替えないこと。

---

## 28. 完了条件

以下をすべて満たすこと。

* GPSイベントと予測更新が分離されている
* GPSが来なくても状態更新が継続する
* 線路上1次元座標で位置を管理できる
* GPS途絶中も速度と位置を推定できる
* GPS復帰時に滑らかに同期できる
* 信頼度とNavigationModeを管理できる
* DeviceMotionの利用可否を実機判定できる
* DeviceMotionなしでも動作する
* 端末操作時にモーション誤積分を防止できる
* デバッグ画面で推定根拠を確認できる
* 実走ログを保存・再生できる
* GPS欠落を人工的に再現できる
* TypeScript版の性能計測ができる
* Web Workerへ処理を分離できる
* WASM導入判断に必要な計測結果を取得できる

---

## 29. 実装順序

以下の順序で実装すること。

1. GPS更新と予測タイマーの分離
2. 線路上1次元状態の導入
3. 速度保持と加速度減衰
4. NavigationModeと信頼度
5. GPS復帰時の補正
6. デバッグ画面
7. ログ記録と再生
8. GPS欠落シミュレーション
9. DeviceMotion利用可否の実機検証
10. モーション補助
11. 端末操作検出
12. Web Worker境界の導入
13. 性能計測
14. WASM導入要否の判断

WASM化を、状態推定ロジックの完成前に開始してはならない。
