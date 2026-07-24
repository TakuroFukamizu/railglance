# TODO & 将来拡張計画 (Phase 2 & Phase 3)

## Phase 1 完了項目

- [x] スマートフォンGeolocation APIによる位置情報の連続取得 (`BrowserLocationProvider`)
- [x] 多重速度ソースの並行計算 (`SpeedEstimator`: OS速度, GPS位置差分速度, 線路上移動距離速度)
- [x] 速度採用判断ロジックの分離 (`SpeedSelector`: 信頼度・精度に基づくソース自動選択)
- [x] 停車判定 (3km/h未満継続) および外れ値・GPSドリフト除外・EMA平滑化 (`SpeedFilter`)
- [x] 将来拡張用センサーフュージョンインターフェース (`SensorFusionProvider`)
- [x] 静的鉄道データのローカル保存・IndexedDB投入 (`DexieRailwayDatabase`)
- [x] 路線セグメントのマップマッチングと候補スコアリング (`CandidateScorer`)
- [x] ヒステリシスによるチャタリング・誤路線切替抑制 (`MapMatcher`)
- [x] 進行方向・前駅・次駅および線路上残距離推定 (`JourneyStateEstimator`)
- [x] Even G2 向けHUDテキストフォーマットおよび1秒描画ループ分離 (`HudRenderer`, `AppController`)
- [x] スマホ画面用リアルタイムHUDプレビュー & 多重速度ソース比較デバッグパネル (`DebugPanel`)
- [x] 全ドメインロジックの Vitest 単体テストおよび GPS ログ再生モジュール (`GpsLogReplayer`)

---

## Phase 2: 静的時刻表照合 & 列車同定 & センサーフュージョン

- [ ] `SensorFusionProvider` の実実装 (加速度センサー / DeviceMotion 連携による速度補正)
- [ ] `TimetableRepository` の実装 (同梱GTFS/静的時刻表データのIndexedDB化)
- [ ] `TrainCandidateEstimator` の実装 (現在時刻、進行方向、現在位置から該当列車ダイヤの同定)
- [ ] 列車種別 (各駅停車、急行、快速急行など) および行先名のHUD追加表示
- [ ] 列車番号 (Train Number) の同定と表示
- [ ] 通過予定駅および次駅到着予定時刻のカウントダウン表示

---

## Phase 3: オンライン補正 & リアルタイム連携

- [ ] `RealtimeTransitRepository` の実装 (ODPT API / GTFS-RT 連携)
- [ ] 遅延情報 (〇分遅れ) および運休・運転見合わせ通知
- [ ] リアルタイム列車位置データによるマップマッチング位置補正
- [ ] 自前バックエンド API Gateway による API キー秘匿およびデータ正規化
- [ ] 通信切断時のスムーズなオフライン Phase 1 モードへの自動フォールバック
