# Even G2 Train HUD Plugin

Even G2上に、乗車中の列車の走行速度・路線・進行方向・前駅・次駅を表示するプラグインの実装です。

本リポジトリでは、**Phase 1: 完全オフラインでの路線推定とHUD表示** を実装しています。

---

## 主な機能（Phase 1）

スマートフォンのGPS情報とクライアント内の静的鉄道データ（IndexedDB / Dexie）を使い、ネットワーク接続なしで以下を推定・表示します。

- 現在速度 (m/s ➔ km/h 変換、EMA平滑化、外れ値・GPSドリフト除外)
- 路線名 (候補マップマッチング、スコアリング、ヒステリシス切り替え抑制)
- 進行方向 (上り・下り・方向A・方向B)
- 前駅・次駅
- 次駅までのおおよその距離 (線路ポリライン上の距離)
- GPS状態 (精度判定、有効性チェック、自動フォールバック)
- 推定信頼度 (0.00 〜 1.00)

---

## HUD 表示スタイル

### 通常表示
```text
  93 km/h

小田急小田原線 上り
海老名 → 座間

NEXT 4.2 km   GPS ●
```

### 路線判定中 (信頼度 < 0.55 または複数候補拮抗時)
```text
  76 km/h

路線判定中
GPSから路線を確認中
```

### GPS不良 / 信号なし
```text
  -- km/h

GPS信号なし
位置情報を確認してください
```

---

## セットアップ & 実行手順 (pnpm)

### 1. 依存ライブラリのインストール
```bash
pnpm install
```

### 2. 開発サーバー & 公式シミュレーターの一括起動 (推奨)
```bash
pnpm dev
```
`pnpm dev` 1コマンドで **Vite 開発サーバー** の起動待ちと **EvenHub 公式シミュレーター (`evenhub-simulator`)** が全自動で同時立ち上がり、Even G2スマートグラス実機と同等の解像度・視野角・プロトコルでリアルタイム検証が始まります。

その他のサブコマンド:
* `pnpm dev:web`: Webブラウザ単体で開発サーバーを起動
* `pnpm sim`: 公式シミュレーター単体を起動

### 3. 単体テストの実行
```bash
pnpm test
```

---

## ディレクトリ構成

```text
src/
  app/
    app-controller.ts          # 位置情報処理と1秒描画ループの分離管理
    bootstrap.ts               # アプリケーション初期化
  config/
    tracking-config.ts         # GPS閾値・EMAアルファ・ヒステリシス設定
  domain/
    geo/
      distance.ts              # Haversine距離 & 点-線分最短距離
      heading.ts               # Bearing & Heading角度差計算
      polyline.ts              # ポリライン沿い距離計算
    speed/
      speed-estimator.ts       # 速度取得・計算・タイムアウト
      speed-filter.ts          # EMA平滑化・停車判定
    railway/
      candidate-scorer.ts      # 候補路線・セグメントスコアリング
      map-matcher.ts           # マップマッチング & ヒステリシス制御
      journey-state-estimator.ts # 進行方向・駅・残距離推定
      confidence.ts            # 信頼度算出
    models/
      location.ts              # 位置・速度型定義
      railway.ts               # 路線・駅・セグメント型定義
      hud.ts                   # HUD ViewModel型定義
    interfaces/
      future-interfaces.ts     # Phase 2 / Phase 3 用将来拡張インターフェース
  infrastructure/
    geolocation/
      browser-location-provider.ts # Geolocation watchPosition & 自動フォールバック
    storage/
      dexie-railway-database.ts # Dexie.js IndexedDB & Bundled JSON投入
    even-g2/
      even-g2-adapter.ts       # Even G2 SDK / EvenHub Simulator Bridge Adapter
      hud-renderer.ts          # HUDテキスト描画フォーマッタ
    logging/
      logger.ts                # 推定ログ配信
  data/sample/                 # 同梱サンプル鉄道データ (小田急線 & JR東日本新幹線)
    lines.json
    stations.json
    track-segments.json
    metadata.json
  ui/
    debug-panel.ts             # スマホ画面開発者デバッグパネル
index.html
tests/                         # Vitest 単体テスト & GPSログ再生器
```

---

## データ更新方法 (静的鉄道データ)

新しい路線や駅を追加・更新する場合は、`src/data/sample/` 内の JSON ファイルを更新してください。

- `lines.json`: 路線情報 (`id`, `name`, `directionAName`, `directionBName`)
- `stations.json`: 駅情報 (`id`, `lineId`, `name`, `sequence`, `latitude`, `longitude`)
- `track-segments.json`: 駅間線路ポリライン座標 (`coordinates: [[lat, lon], ...]`, `lengthMeters`)
- `metadata.json`: バージョン番号 (`version` を更新すると初回起動時に IndexedDB が再読み込みされます)
