# Even G2 Train HUD Plugin

Even G2上に、乗車中の列車の走行速度・路線・進行方向・前駅・次駅を表示するプラグインの実装計画です。

本リポジトリでは、まず **Phase 1: 完全オフラインでの路線推定とHUD表示** を実装します。

## Phase 1の目標

スマートフォンのGPS情報とクライアント内の静的鉄道データを使い、ネットワーク接続なしで以下を推定・表示します。

- 現在速度
- 路線名
- 進行方向
- 前駅
- 次駅
- 次駅までのおおよその距離
- GPS状態
- 推定信頼度

## 想定表示

```text
  93 km/h

小田急小田原線 上り
海老名 → 座間

NEXT 4.2 km   GPS ●
```

GPSまたは路線推定の信頼度が低い場合は、誤った情報を断定しません。

```text
  -- km/h

路線判定中
GPSを確認しています
```

## Phase構成

### Phase 1: オフライン路線HUD

- GPSから速度を取得
- GPS速度の平滑化
- 路線形状とのマップマッチング
- 進行方向の判定
- 前駅・次駅の推定
- 次駅までの距離計算
- Even G2向けHUD表示
- ローカル鉄道DB
- 実機ログとデバッグ表示

### Phase 2: 静的時刻表との照合

- 列車候補の推定
- 列車種別
- 行先
- 列車番号
- 停車駅・通過駅
- 予定時刻
- 候補信頼度

### Phase 3: オンライン補正

- リアルタイム列車位置
- 遅延・運休
- 臨時列車
- 番線変更
- GTFS-RT、ODPT、事業者API連携
- 自前バックエンドによるAPIキー秘匿とデータ正規化

## 推奨技術構成

- TypeScript
- Even G2 / Even Hub SDK
- WebView上のGeolocation API
- IndexedDB
- Dexie.js
- Turf.js、または同等の地理計算ライブラリ
- Vitest
- ESLint
- Prettier

## データ方針

Phase 1では全国対応を最初から行いません。最初の対象は、検証しやすい1路線または1事業者に限定します。

候補例:

- 小田急小田原線
- 相鉄本線
- JR相模線

詳細:

- `ANTIGRAVITY_PROMPT.md`
- `docs/PHASE1_IMPLEMENTATION.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/ASSUMPTIONS.md`
