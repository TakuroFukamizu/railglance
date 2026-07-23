# Antigravity実装プロンプト

あなたは、Even G2向けプラグインを実装するシニアTypeScriptエンジニアです。

このリポジトリに、乗車中の列車の走行速度・路線・進行方向・前駅・次駅をEven G2上に表示するプラグインを実装してください。

まずは `docs/PHASE1_IMPLEMENTATION.md` に記載された **Phase 1のみ** を実装してください。Phase 2、Phase 3の機能は実装せず、将来拡張できるインターフェースとTODOのみ用意してください。

## 実装の目的

スマートフォンのGPS情報と、クライアント内に保存した静的鉄道データを使い、ネットワーク接続なしで次を表示します。

- 現在速度
- 路線名
- 進行方向
- 前駅
- 次駅
- 次駅までのおおよその距離
- GPS状態
- 路線推定の信頼度

## 最重要方針

1. Even G2は表示端末として使い、位置取得・速度計算・路線推定はスマートフォン側で行うこと。
2. Phase 1では外部APIを呼ばないこと。
3. 誤った路線を断定しないこと。信頼度が低い場合は「路線判定中」と表示すること。
4. GPSの瞬間値をそのまま表示せず、平滑化・外れ値除外を行うこと。
5. 並走路線や駅周辺での誤判定を減らすため、距離だけでなく進行方向と直前状態を使うこと。
6. UI更新頻度を位置取得頻度から分離すること。
7. ロジックをSDK依存コードから分離し、単体テスト可能にすること。
8. 実機でのデバッグを容易にするため、推定根拠をログに出力すること。

## 想定アーキテクチャ

```text
Geolocation API
    ↓
LocationProvider
    ↓
SpeedEstimator
    ↓
MapMatcher
    ↓
JourneyStateEstimator
    ↓
HUD ViewModel
    ↓
Even G2 SDK Adapter
```

ローカル鉄道DB:

```text
Bundled JSON / IndexedDB
    ├─ lines
    ├─ stations
    ├─ trackSegments
    └─ datasetMetadata
```

## 推奨ディレクトリ構成

```text
src/
  app/
    bootstrap.ts
    app-controller.ts
  config/
    tracking-config.ts
  domain/
    geo/
      distance.ts
      heading.ts
      polyline.ts
    speed/
      speed-estimator.ts
      speed-filter.ts
    railway/
      map-matcher.ts
      candidate-scorer.ts
      journey-state-estimator.ts
      confidence.ts
    models/
      location.ts
      railway.ts
      hud.ts
  infrastructure/
    geolocation/
      browser-location-provider.ts
    storage/
      railway-database.ts
      dexie-railway-database.ts
    even-g2/
      even-g2-adapter.ts
      hud-renderer.ts
    logging/
      logger.ts
  data/sample/
    lines.json
    stations.json
    track-segments.json
    metadata.json
  ui/
    debug-panel.ts
    settings.ts

tests/
  speed/
  railway/
  geo/
```

既存テンプレートの構成がある場合は、それを優先しつつ責務分離は維持してください。

## 実装対象

### 1. 位置情報取得

`navigator.geolocation.watchPosition()` を利用してください。

```ts
{
  enableHighAccuracy: true,
  maximumAge: 500,
  timeout: 5000
}
```

以下を扱ってください。

- latitude
- longitude
- accuracy
- speed
- heading
- timestamp

`coords.speed` または `coords.heading` が `null` の場合に備えて、過去の位置履歴から計算してください。

### 2. 速度推定

速度は次の優先順位で取得してください。

1. 有効な `coords.speed`
2. 直前位置との距離と経過時間から計算
3. 計算不能の場合は不明

要件:

- m/sからkm/hへ変換
- 指数移動平均などで平滑化
- 非現実的な加速度・速度を除外
- 停車中のGPSドリフト抑制
- GPS精度が悪い測位値の除外
- 最終有効値の短時間保持
- 一定時間更新がない場合は不明表示

初期値の目安:

```text
GPS精度除外: accuracy > 50m
停車判定: 3km/h未満が数秒継続
HUD更新: 1秒
位置更新タイムアウト: 5秒
速度上限: 400km/h
```

しきい値は設定ファイルへ切り出してください。

### 3. 路線マップマッチング

現在位置から近い線路セグメントを検索し、候補路線をスコアリングしてください。

候補スコアの要素:

- GPS地点と線路セグメントの距離
- GPSの進行方向と線路方向の差
- 直前に選択されていた路線との連続性
- 直前セグメントとの連続性
- GPS精度
- 速度
- 一定時間内の位置履歴との整合性

最低限、次のケースを考慮してください。

- 並走路線
- 駅構内
- 線路のカーブ
- GPSが一時的に道路側へ飛ぶ
- トンネル突入
- GPS停止
- 上下線が近接している区間

単一地点だけで即座に路線を切り替えず、一定回数または一定時間、別候補が優勢な場合のみ切り替えてください。

### 4. 進行方向・駅推定

選択された路線と移動方向から、次を推定してください。

- 上り・下り、または方向A・方向B
- 直前駅
- 次駅
- 次駅までの線路上距離

単純な直線距離ではなく、可能な範囲で線路ポリライン上の距離を使ってください。

路線固有の「上り・下り」表記が未定義の場合は方面表示にしてください。

### 5. ローカルDB

Phase 1ではIndexedDBを利用し、Dexie.jsを使用してください。

必要テーブル:

```ts
lines
stations
trackSegments
datasetMetadata
```

推奨モデル:

```ts
type RailwayLine = {
  id: string;
  operatorId: string;
  name: string;
  shortName?: string;
  directionAName?: string;
  directionBName?: string;
};

type Station = {
  id: string;
  lineId: string;
  name: string;
  sequence: number;
  latitude: number;
  longitude: number;
};

type TrackSegment = {
  id: string;
  lineId: string;
  fromStationId: string;
  toStationId: string;
  coordinates: Array<[number, number]>;
  lengthMeters?: number;
};

type DatasetMetadata = {
  version: string;
  generatedAt: string;
  area: string;
};
```

初回起動時に同梱JSONをIndexedDBへ投入し、バージョンが変わった場合のみ更新してください。

### 6. HUD表示

優先順位:

1. 速度
2. 路線名
3. 進行方向
4. 前駅 → 次駅
5. 次駅までの距離
6. GPS状態

通常表示:

```text
  93 km/h

小田急小田原線 上り
海老名 → 座間

NEXT 4.2 km   GPS ●
```

判定中:

```text
  76 km/h

路線判定中
GPSから路線を確認中
```

GPS不良:

```text
  -- km/h

GPS信号なし
位置情報を確認してください
```

HUD更新は1秒周期を基本とし、位置情報取得ごとに即座にG2へ描画しないでください。

### 7. デバッグUI

スマートフォン画面には開発時のみ次を表示してください。

- 生のGPS値
- フィルタ後速度
- GPS精度
- heading
- 候補路線一覧
- 候補ごとのスコア内訳
- 採用路線
- 採用セグメント
- 前駅・次駅
- 信頼度
- 最終更新時刻

### 8. テスト

最低限、次の単体テストを用意してください。

- 2点間距離
- heading計算
- 速度計算
- EMA平滑化
- 停車判定
- 外れ値除外
- GPS精度による除外
- 線路との距離計算
- 方向差の計算
- 候補スコアリング
- ヒステリシスによる路線切替抑制
- 前駅・次駅推定
- 次駅までの距離

GPSログを再生するテスト用インターフェースも用意してください。

## Phase 1の非対象

以下は実装しないでください。

- 列車番号
- 列車種別
- 行先推定
- 静的時刻表照合
- 遅延情報
- 運休情報
- リアルタイム列車位置
- GTFS-RT
- ODPT API
- 独自バックエンド
- 全国路線対応
- ユーザーアカウント
- クラウド同期

ただし、将来追加できるよう以下のインターフェースだけ定義してください。

```ts
interface TimetableRepository {}
interface RealtimeTransitRepository {}
interface TrainCandidateEstimator {}
```

## 完了条件

- 位置情報から速度を表示できる
- GPSが不安定な場合に誤表示を抑制できる
- 対象路線上で路線名を推定できる
- 進行方向を推定できる
- 前駅・次駅を表示できる
- 次駅までのおおよその距離を表示できる
- 信頼度が低いときに断定表示しない
- Even G2実機またはSDKシミュレーターでHUDを表示できる
- ロジック部分に単体テストがある
- デバッグ画面で推定根拠を確認できる
- READMEにセットアップ・実行・データ更新方法が記載されている

## 作業手順

1. 既存リポジトリ構造とEven G2 SDKテンプレートを確認する
2. 実装計画を `IMPLEMENTATION_PLAN.md` に作成する
3. ドメインモデルとインターフェースを定義する
4. サンプル路線データを作成する
5. GPS取得と速度推定を実装する
6. マップマッチングを実装する
7. 駅・方向推定を実装する
8. HUDを実装する
9. デバッグ画面を実装する
10. テストを追加する
11. READMEを更新する
12. 残課題を `TODO.md` に整理する

## 実装時の報告形式

```text
実装済み:
- ...

確認済み:
- ...

未確認:
- ...

次に行うこと:
- ...
```

不明点があっても実装を止めず、妥当な仮定を `docs/ASSUMPTIONS.md` に記録して進めてください。
