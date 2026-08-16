# Cloudflare R2 データセットデプロイ手順書

本文書は、RailGlance の静的 H3 鉄道タイルデータセット (`dist/railway-dataset/`) を Cloudflare R2 ストレージバケットへデプロイ・公開するための手順書である。

---

## 1. 前提条件 ＆ 準備（正しい実行順序）

### Step 1: R2 バケットの作成および公開 URL 設定（最初に実行）
1. [Cloudflare Dashboard](https://dash.cloudflare.com/) にログインし、左メニュー **R2** を選択します。
2. 画面上の **[Create bucket]** ボタンをクリックします。
3. バケット名を入力: `railglance-dataset-bucket`
4. 設定はデフォルトのまま **[Create bucket]** を押して作成します。
5. **公開 URL の設定 (以下のいずれかを選択)**:

   * **パターン A: 無料開発用 URL (`r2.dev`) を使う場合（独自ドメイン不要・最速）**:
     1. 作成したバケットの **[Settings]** タブを開きます。
     2. **[Public access]** 項目にある **R2.dev bucket access** の **[Allow Access]** ボタンを押します。
     3. 確認モーダルで `allow` と入力して有効化すると、`https://pub-xxxxxx.r2.dev` という公開 URL が即座に発行されます。

   * **パターン B: 独自ドメイン (`Custom Domain`) を使う場合 (本番運用向け)**:
     1. バケットの **[Settings]** タブ ➔ **Custom Domains** ➔ **[Connect Domain]** を選択します。
     2. お持ちのドメインを入力 (例: `data.railglance.example`) して接続します。

---

### Step 2: Cloudflare アカウント ID と R2 API トークンの取得
1. 左メニュー **R2** のトップ画面（または Account 概要）を表示し、画面右側の **Account ID** をコピーします。
2. 左メニュー **R2** ➔ **[Manage R2 API Tokens]** を選択します。
3. 画面右上の青いボタン **[Create Account API token]** をクリックします。
4. トークン設定:
   * **Permissions**: **Object Read & Write** (書き込み・編集権限)
   * **Apply to specific buckets only**: Step 1 で作成した `railglance-dataset-bucket` を選択（または All buckets）
5. 発行された **Access Key ID** および **Secret Access Key** をコピーして保存します。

---

## 2. ローカル環境からのデプロイ手順

### 2.1 環境変数の設定
ターミナルで以下の環境変数を設定します：

```bash
export R2_ACCOUNT_ID="your_cloudflare_account_id"
export R2_ACCESS_KEY_ID="your_r2_access_key_id"
export R2_SECRET_ACCESS_KEY="your_r2_secret_access_key"
export R2_BUCKET_NAME="railglance-dataset-bucket" # 省略時はデフォルト
export R2_CORS_ALLOWED_ORIGINS="https://app.example,https://preview.example"
export DATASET_VERSION="1.4.0" # 必須。公開済みでないSemVerを毎回明示
export MLIT_N02_DIR="/path/to/N02-23/UTF-8" # 必須
```

`DATASET_VERSION` と `MLIT_N02_DIR` は **必須** です。既定値へのフォールバックは存在せず、どちらかが
欠けている場合はビルドもデプロイも失敗します（fail closed）。

`MLIT_N02_DIR` には国土交通省「国土数値情報 鉄道データ N02-23」の
`N02-23_RailroadSection.geojson` と `N02-23_Station.geojson` を置きます。2020年度以降の同データは
CC BY 4.0 です。合成した路線名は使用せず、駅・線形・出典を GeoJSON から変換します。

### 2.2 データセット生成 ＆ デプロイの実行

```bash
pnpm deploy:r2
```

このコマンドにより以下が自動実行されます：
1. 品質ゲートを通過した関東圏データセットの ETL ビルド (`pnpm build:data`)
2. デプロイ前の配備ゲート検証（下記 2.3）
3. `dist/railway-dataset/v${DATASET_VERSION}/*` の H3 タイル・マニフェストを R2 へ長期キャッシュ付き送信 (`Cache-Control: public, max-age=31536000, immutable`)
4. 最後に `/datasets/latest.json` をアトミック切り替え送信 (`Cache-Control: public, max-age=300, must-revalidate`)

デプロイ処理は先に R2 の manifest キーを確認し、同じ version が存在すれば失敗します。公開済み version の
上書きはできません。認証情報がない場合も失敗します。

### 2.3 配備ゲート（fail closed）

`deploy-r2.ts` は **S3 クライアントを生成する前** に以下をすべて検証します。1つでも満たさない場合は
オブジェクトが1件もアップロードされないまま失敗します。

| 検証項目 | 失敗条件 |
|---|---|
| 明示 SemVer | `DATASET_VERSION` 未設定、または `x.y.z[-prerelease]` 形式でない |
| ビルド一致 | `latest.json` の version が `DATASET_VERSION` と不一致（古い `dist/` の誤配備防止） |
| MLIT 出典 | manifest の `mlitSourced` が `true` でない、または `sources` に `mlit-n02-23` を含まない |
| 最低品質 | 路線数 < 7、駅数 < 56、駅間セグメント数 < 49、H3タイル数 < 254 |

品質ゲートのしきい値は、リポジトリに同梱されたベースラインデータセット (`src/data/sample`: 7路線 /
56駅 / 49セグメント) をそのままビルドしたときの実測値 (7 / 56 / 49 / 254タイル) です。MLIT を併合した
本番ビルドは必ずこれ以上の規模になるため、これを下回るビルドは欠損・破損とみなして配備しません。

ネットワーク変更を行わずに配備ゲートだけ確認したい場合は、ビルド済みの `dist/` と `DATASET_VERSION` を
用意したうえで次を実行します（認証情報は不要）：

```bash
pnpm deploy:r2:dry-run
```

### 2.4 サンプルのみのローカルビルド

MLIT データを持たないローカル開発では、明示フラグ付きのサンプル専用ビルドを使います：

```bash
pnpm build:data:sample
```

このビルドは `MLIT_N02_DIR` を必要とせず、出力 version を `0.0.0-sample` に固定し、manifest に
`mlitSourced: false` を記録します。カバレッジレポートも `docs/` ではなく
`dist/railway-dataset/kanto-coverage-report.sample.md` へ書き出します。このデータセットは上記 2.3 の
MLIT 出典ゲートで必ず拒否されるため、R2 へ配備することはできません。

デプロイ時には `R2_CORS_ALLOWED_ORIGINS` を使って bucket CORS も更新します。ブラウザの Origin と完全一致する
値を列挙し、`*` は本番では使用しません。反映後はブラウザから `latest.json` と任意の H3 tile を取得し、
レスポンスの `Access-Control-Allow-Origin` を確認します。

---

## 3. クライアント アプリケーションでの受信設定

リポジトリルートの `.env.example` をコピーして `.env` を作成します：

```bash
cp .env.example .env
```

`.env` 内の `VITE_RAILWAY_DATA_BASE_URL` を設定します：

```env
# パターンAの場合 (r2.dev)
VITE_RAILWAY_DATA_BASE_URL=https://pub-xxxxxx.r2.dev

# パターンBの場合 (独自ドメイン)
# VITE_RAILWAY_DATA_BASE_URL=https://data.railglance.example
```

アプリ起動時に `VITE_RAILWAY_DATA_BASE_URL/datasets/latest.json` ➔ マニフェスト ➔ H3 タイルが自動参照・同期されます。
