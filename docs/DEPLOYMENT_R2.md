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
```

### 2.2 データセット生成 ＆ デプロイの実行

```bash
pnpm deploy:r2
```

このコマンドにより以下が自動実行されます：
1. 関東1都6県全線データセット ETL ビルド (`pnpm build:data`)
2. `dist/railway-dataset/v1.0.0/*` の全 H3 タイル・マニフェストを R2 へ長期キャッシュ付き送信 (`Cache-Control: public, max-age=31536000, immutable`)
3. 最後に `/datasets/latest.json` をアトミック切り替え送信 (`Cache-Control: public, max-age=300, must-revalidate`)

---

## 3. クライアント アプリケーションでの受信設定

Web アプリ（`.env` または `.env.production`）にて以下を設定します：

```env
# パターンAの場合 (r2.dev)
VITE_RAILWAY_DATA_BASE_URL=https://pub-xxxxxx.r2.dev

# パターンBの場合 (独自ドメイン)
# VITE_RAILWAY_DATA_BASE_URL=https://data.railglance.example
```

アプリ起動時に `VITE_RAILWAY_DATA_BASE_URL/datasets/latest.json` ➔ マニフェスト ➔ H3 タイルが自動参照・同期されます。
