# TODO & 将来拡張計画 (Phase 2 & Phase 3)

## Phase 1 完了項目

- [x] スマートフォンGeolocation APIによる位置情報の連続取得 (`BrowserLocationProvider`)
- [x] GPS速度および位置差分による速度推定 & EMA平滑化 (`SpeedEstimator`, `SpeedFilter`)
- [x] 停車判定 (3km/h未満継続) および外れ値・高精度外 sample 除外
- [x] 静的鉄道データのローカル保存・IndexedDB投入 (`DexieRailwayDatabase`)
- [x] 路線セグメントのマップマッチングと候補スコアリング (`CandidateScorer`)
- [x] ヒステリシスによるチャタリング・誤路線切替抑制 (`MapMatcher`)
- [x] 進行方向・前駅・次駅および線路上残距離推定 (`JourneyStateEstimator`)
- [x] Even G2 向けHUDテキストフォーマットおよび1秒描画ループ分離 (`HudRenderer`, `AppController`)
- [x] スマホ画面用リアルタイムHUDプレビュー & 開発者デバッグパネル (`DebugPanel`)
- [x] 全ドメインロジックの Vitest 単体テストおよび GPS ログ再生モジュール (`GpsLogReplayer`)

---

## Phase 2: 静的時刻表照合 & 列車同定

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
