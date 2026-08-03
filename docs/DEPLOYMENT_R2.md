# Cloudflare R2 データセットデプロイ手順書

本文書は、RailGlance の静的 H3 鉄道タイルデータセット (`dist/railway-dataset/`) を Cloudflare R2 ストレージバケットおよび Custom Domain へデプロイするための手順書である。

---

## 1. 前提条件 ＆ 準備

### 1.1 Cloudflare アカウント ID と R2 API トークンの取得
1. [Cloudflare Dashboard](https://dash.cloudflare.com/) にログインし、右側の **Account ID** をコピーします。
2. 左メニュー **R2** ➔ **Manage R2 API Tokens** を選択します。
3. 画面上の青いボタン **[Create Account API token]** をクリックします。
4. トークン設定:
   * **Permissions**: **Object Read & Write** (書き込み・編集権限)
   * **Specify bucket**: 対象バケット（例: `railglance-dataset-bucket`）または All buckets
5. 発行された **Access Key ID** および **Secret Access Key** を保存します。

### 1.2 R2 バケットの作成および Custom Domain 設定
1. Cloudflare Dashboard ➔ **R2** ➔ **Create bucket** ➔ バケット名: `railglance-dataset-bucket`
2. 作成したバケットの **Settings** ➔ **Custom Domains** ➔ **Connect Domain**
3. ドメインを入力 (例: `data.railglance.example`)
4. DNS 設定が自動追加され、HTTPS 証明書が即座に発行されます。

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

## 3. GitHub Actions CI/CD パイプラインでの自動デプロイ

リポジトリの Secrets に以下を設定すると、`main` ブランチ更新時に自動デプロイされます：

1. **GitHub Secret 設定**:
   * `R2_ACCOUNT_ID`: Cloudflare アカウント ID
   * `R2_ACCESS_KEY_ID`: R2 API Access Key ID
   * `R2_SECRET_ACCESS_KEY`: R2 API Secret Access Key
   * `R2_BUCKET_NAME`: `railglance-dataset-bucket`

2. パイプライン設定ファイル: [.github/workflows/deploy-r2.yml](file:///Users/takuro/src/railglance/.github/workflows/deploy-r2.yml)

---

## 4. クライアント アプリケーションでの受信設定

Web アプリ（`.env` または `.env.production`）にて以下を設定します：

```env
VITE_RAILWAY_DATA_BASE_URL=https://data.railglance.example
```

アプリ起動時に `VITE_RAILWAY_DATA_BASE_URL/datasets/latest.json` ➔ マニフェスト ➔ H3 タイルが自動参照・同期されます。
