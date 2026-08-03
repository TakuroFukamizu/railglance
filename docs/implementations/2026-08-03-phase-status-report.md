# RailGlance 実装状況レポート

作成日: 2026-08-03  
対象ブランチ: `main`  
確認時点の最新コミット: `44b949f71ed90694007d63b8c7fb4391629db79e`

## 1. 概要

RailGlanceは、スマートフォン側でGPS・静的鉄道データ・推定ロジックを処理し、Even G2へ現在速度、路線、進行方向、前駅・次駅、次駅までの距離、GPS / デッドレコニング状態を表示するアプリとして実装が進んでいる。

現時点では、当初のPhase 1 MVPの中心機能は概ね実装済みであり、Even G2実機へのHUD表示も成立している。一方、追加されたTrack-Constrained Dead Reckoning要件まで含めると、GPS途絶時の速度継続は実装済みだが、線路上位置・駅間・残距離を継続更新する機能は未完成である。また、DeviceMotionは権限取得とイベント受信のPoCまで実装されているが、実際の速度推定・状態推定経路には接続されていない。

## 2. 総合達成度

| 評価対象 | 達成度の目安 | 判定 |
|---|---:|---|
| 当初のPhase 1 MVP | 85% | 基本機能は成立 |
| DR・HUD再設計を含む拡張Phase 1 | 70〜75% | 主要な未達あり |
| 実走・長時間運用を含む完成度 | 60〜70% | 実機検証と補強が必要 |
| Phase 2 | 10〜20% | インターフェースと一部PoCのみ |
| Phase 3 | 0〜5% | 将来用インターフェースのみ |

## 3. Phase 1 実装状況

### 3.1 位置情報取得

実装済み。

- `navigator.geolocation.watchPosition()`による連続取得
- 緯度、経度、精度、速度、heading、timestampの取得
- 実GPSとデモGPSリプレイヤーの切り替え
- GPS観測更新とHUD描画タイマーの分離

主な実装:

- `src/infrastructure/geolocation/browser-location-provider.ts`
- `src/app/app-controller.ts`
- `src/main.ts`

残課題:

- 長時間バックグラウンド・フォアグラウンド復帰試験
- 権限拒否、タイムアウト、OSによる更新間隔変化の実機評価

達成度: **90%**

### 3.2 速度推定

実装済み。

利用している速度候補:

1. OS Geolocationの`coords.speed`
2. GPS位置差分速度
3. 線路ポリライン上の移動距離速度
4. デッドレコニング速度

加えて以下が実装されている。

- `SpeedSelector`による速度ソース選択
- EMA平滑化
- 停車判定
- GPSドリフト抑制
- 最大速度チェック
- 速度ソース切り替えログ

主な実装:

- `src/domain/speed/speed-estimator.ts`
- `src/domain/speed/speed-selector.ts`
- `src/domain/speed/speed-filter.ts`

残課題:

- 速度候補同士の乖離を用いた異常値判定
- 加速度上限を用いた候補単位の棄却
- 実走ログによる閾値調整

達成度: **85〜90%**

### 3.3 路線特定・マップマッチング

MVPとして実装済み。

- 近傍線路セグメント検索
- ポリラインへの射影
- 距離スコア
- headingスコア
- 現在セグメントとの連続性スコア
- GPS精度スコア
- ヒステリシスによる路線切り替え抑制
- 同一路線内のセグメント遷移高速化

主な実装:

- `src/domain/railway/map-matcher.ts`
- `src/domain/railway/candidate-scorer.ts`
- `src/domain/railway/confidence.ts`

残課題:

- `findSegmentsNear()`が全セグメント・全座標を走査している
- 分岐、複々線、長い並走区間への対応が弱い
- 候補履歴を系列として評価するHMM等は未実装
- 線路接続関係を明示したグラフモデルがない

達成度: **75〜80%**

### 3.4 進行方向・前駅・次駅・残距離

GPS観測が継続している状態では実装済み。

- 線路方向とheadingから上り・下りを推定
- 低速時は直前位置からheadingを補完
- 現在セグメントから前駅・次駅を決定
- ポリライン上の位置から次駅までの距離を算出

主な実装:

- `src/domain/railway/journey-state-estimator.ts`

残課題:

- GPS途絶中に`JourneyStateEstimator.update()`が呼ばれない
- DR中は前駅・次駅・残距離が最後のGPS時点で停止する
- 駅停車・通過による区間遷移を時間駆動で更新できない

通常GPS時の達成度: **80〜85%**

### 3.5 Track-Constrained Dead Reckoning

速度継続とNavigationModeは実装済み。

実装済み内容:

- `gps-locked`
- `gps-degraded`
- `dead-reckoning`
- `dead-reckoning-low-confidence`
- `reacquiring`
- `lost`
- GPS途絶直後の加速度傾向維持
- 定速走行の短時間保持
- 長時間途絶時の緩やかな速度低下
- 信頼度の時間減衰
- GPS復帰時の速度・位置ブレンド

主な実装:

- `src/domain/speed/navigation-state-estimator.ts`
- `src/domain/speed/speed-estimator.ts`

重大な未達:

- `trackPositionMeters`は路線起点からの累積距離ではなく、現在セグメント内距離として扱われている
- セグメント終端を超えた際の次セグメントへの遷移がない
- DR中の前駅・次駅・残距離更新がない
- 分岐時の候補経路保持がない
- GPS復帰時に路線・区間を安定再同期する専用処理がない

速度継続の達成度: **75〜80%**  
区間・位置継続の達成度: **40〜50%**

### 3.6 DeviceMotion / センサーフュージョン

PoC実装あり。ただし速度推定には未接続。

実装済み:

- DeviceMotionイベントの購読
- iOS向け権限要求
- WebViewでのイベント受信フォールバック
- 加速度Magnitudeの平滑化
- 簡易停止判定
- 最終速度を基準にした簡易速度推定

主な実装:

- `src/infrastructure/sensors/device-motion-sensor-fusion-provider.ts`
- `src/domain/interfaces/sensor-fusion.ts`

未達:

- `estimateSpeed()`が`SpeedEstimator`から呼ばれていない
- `sensorFusionSpeed`は常に`null`
- `NavigationStateEstimator.updateWithMotion()`が呼ばれていない
- 重力除去が不十分
- 端末姿勢から地球座標系への変換がない
- 線路接線方向への加速度射影がない
- センサーバイアス学習がない
- 端末持ち替え・回転検出がない

達成度: **25〜35%**

### 3.7 Even G2 HUD

実機表示まで到達済み。

現在の構成:

- 路線・方向: `TextContainer`
- 大きな速度: Canvas → PNG → `ImageContainer`
- 前駅・次駅: `TextContainer`
- 次駅までの距離、GPS / DR状態: `TextContainer`

実装済み:

- 576×288の固定レイアウト
- TextContainerとImageContainerの非重複配置
- BLEブリッジ呼び出しの直列化
- PNG画像更新のレート制限
- 画像更新タイムアウト
- 画像送信結果のデバッグ表示
- SDK 0.0.12の`compressMode: 2`不具合回避
- 速度値・単位・推定記号の中央揃え

主な実装:

- `src/infrastructure/even-g2/even-g2-adapter.ts`
- `src/infrastructure/even-g2/speed-png-generator.ts`
- `src/infrastructure/even-g2/sdk-image-patch.ts`
- `src/infrastructure/even-g2/hud-renderer.ts`

残課題:

- `progressRatio`が現在`0.5`固定で、実際の駅間進捗を示していない
- 長い駅名・路線名の短縮ルールが十分に接続されていない
- ページ再構築・アプリ復帰時の画像再送耐久性確認
- 長時間連続更新時のBLE安定性確認

達成度: **85%**

### 3.8 ローカル鉄道データ

IndexedDB / Dexieによるオフラインデータ基盤は実装済み。

現在の路線定義:

- 小田急小田原線
- 東北新幹線
- 上越新幹線
- 北陸新幹線
- 京急線
- 相鉄本線
- JR横浜線

残課題:

- 路線データが簡略ポリライン中心で精密線形ではない
- 全路線対応を想定したデータ分割・更新方式がない
- 空間インデックスがない
- 路線分岐・直通運転・複数経路の表現が弱い

Phase 1検証用達成度: **70%**  
製品データ基盤としての達成度: **30%程度**

### 3.9 テスト・デバッグ

基盤は実装済み。

- 距離計算
- heading計算
- SpeedEstimator
- SpeedSelector
- NavigationStateEstimator
- MapMatcher
- JourneyStateEstimator
- デモGPSリプレイヤー
- スマートフォン側デバッグパネル

残課題:

- GitHub ActionsによるCIがない
- 実走ログの保存・再生・GPS欠落注入が十分でない
- トンネル、並走路線、駅停車、GPSジャンプのシナリオ試験が不足
- 1時間以上の連続動作試験が未確認

達成度: **70〜75%**

## 4. Phase 1 完了前に優先すべき作業

### 優先度A

1. 路線起点からの累積距離を表す`RoutePosition`モデルを導入する
2. 各セグメントへ`startOffsetMeters`を持たせる
3. DR中も累積位置を進める
4. セグメント終端通過時に次セグメントへ遷移する
5. GPSイベントがなくてもJourneyStateを再計算する
6. DR中の前駅・次駅・残距離を更新する
7. 実際の距離からHUDの`progressRatio`を計算する

### 優先度B

1. GPS復帰時の路線・区間再同期を強化する
2. 実走ログの保存・再生機能を完成させる
3. GPS欠落・精度劣化・位置ジャンプを注入できるようにする
4. トンネル・駅停車・並走路線で実機試験する
5. 長時間BLE画像更新の耐久性を確認する

### 優先度C

1. 空間検索をグリッド・Geohash・R-tree等へ変更する
2. マップマッチングをWeb Workerへ分離する
3. 文字列短縮・長い駅名の表示規則を完成させる
4. GitHub Actionsで`pnpm test`と`pnpm build`を自動実行する

## 5. Phase 2 実装内容

Phase 2は、静的時刻表照合・列車同定・本格センサーフュージョンを実装する。

### 5.1 本格センサーフュージョン

- DeviceMotion Providerを単一インスタンスとしてDIする
- 重力成分を除去する
- 端末姿勢を推定する
- 端末座標から地球座標へ変換する
- 線路接線方向へ加速度を射影する
- GPS速度変化から加速度バイアスを学習する
- 端末持ち替え・回転中はモーション入力を無効化する
- `sensorFusionSpeed`を速度候補へ追加する
- `NavigationStateEstimator.updateWithMotion()`へ入力する
- GPS途絶中の減速・停車検知へ利用する

### 5.2 静的時刻表リポジトリ

- `TimetableRepository`を実装する
- GTFSまたは事前変換した軽量時刻表をIndexedDBへ保存する
- `routes`
- `trips`
- `stop_times`
- `calendar`
- `calendar_dates`
- `stops`

### 5.3 列車候補同定

`TrainCandidateEstimator`を実装し、以下から候補列車を絞り込む。

- 路線
- 方向
- 現在時刻
- 前駅・次駅
- 駅通過・出発時刻
- 停車駅パターン
- 実測走行時間
- 直前までの候補履歴

候補ごとに時刻整合性、駅順序、停車パターン、継続性のスコアを持たせる。

### 5.4 HUD拡張

信頼度が十分高い場合のみ以下を表示する。

- 列車種別
- 行先
- 列車番号
- 次駅到着予定時刻
- 通過予定駅

信頼度が低い場合は、線名と方向だけを表示する。

## 6. Phase 3 実装内容

Phase 3は、オンライン交通情報による補正とリアルタイム連携を実装する。

### 6.1 リアルタイム交通リポジトリ

- `RealtimeTransitRepository`を実装する
- ODPT API
- GTFS-RT
- 事業者API
- 独自正規化API

取得対象:

- 列車位置
- 遅延時間
- 運休・運転見合わせ
- 行先変更
- 列車番号
- 停車駅変更

### 6.2 オンライン位置補正

- GPSが弱い地下・トンネルで列車位置情報を利用する
- 駅間レベル、駅発着レベル、緯度経度レベルの差を正規化する
- ダイヤ遅延を列車候補同定へ反映する
- 分岐後の列車・路線候補を補正する

### 6.3 バックエンド

- APIキーをクライアントから分離する
- 外部APIのキャッシュ
- レート制限対策
- 複数事業者データの正規化
- 障害時のフォールバック
- Evenアプリ向けの軽量レスポンス生成

想定構成:

```text
Evenアプリ
  ↓
RailGlance API
  ↓
ODPT / GTFS-RT / 各社API
```

### 6.4 フォールバック

オンライン情報が利用できない場合は、次の順で段階的に退避する。

```text
Realtimeデータ
  ↓
静的時刻表による列車推定
  ↓
Phase 1 GPS・マップマッチング・DR
```

## 7. 推奨ロードマップ

### Phase 1完了

1. 路線累積距離モデル
2. DR中の区間・駅・残距離更新
3. 実値の進捗バー
4. GPS復帰時の区間再同期
5. 実走ログ試験
6. 長時間実機試験

### Phase 2

1. DeviceMotionの実推定経路への接続
2. 静的時刻表データ基盤
3. 列車候補同定
4. 種別・行先・列車番号HUD

### Phase 3

1. リアルタイム交通データ取得
2. 列車位置・遅延補正
3. バックエンド正規化API
4. オフライン自動フォールバック

## 8. 結論

RailGlanceは、Phase 1の中心価値である「どの路線・どの区間を、どれくらいの速度で走っているかをEven G2で確認する」ための基本機能を備えている。

ただし、現時点ではGPS途絶時に速度だけが継続し、区間・次駅・残距離は継続更新されない。このため、Phase 1を正式完了とする前に、路線累積距離モデルとDR中のJourneyState更新を完成させる必要がある。

Phase 2の列車同定へ進む前にこの基盤を完成させることで、トンネル・地下・GPS復帰時にも列車候補がずれにくい構成となる。
