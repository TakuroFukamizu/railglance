# ADR 0002: クラウド鉄道データ静的タイル配信基盤の選定 (Cloudflare vs AWS)

* **ステータス**: 承認済み (Accepted)
* **日付**: 2026-08-03
* **関係者**: RailGlance コア開発チーム

---

## 1. コンテキストと問題の定義

RailGlance は、スマートフォンおよびスマートグラス (Even G2) 上でリアルタイム鉄道位置推計・自律航法 (DR) を行う Web アプリケーションである。
路線の駅・線路ポリライン・トポロジー情報は、クライアントの端末内推計のために静的 H3 タイル (`/datasets/{version}/h3/{res}/{cellId}.json`) および `/datasets/latest.json` として配信される。

クライアント端末の位置プライバシー（精密な GPS 座標）をサーバー側へ送信せず、かつ最小の取得遅延と強固な CDN キャッシュ制御を実現するため、クラウド静的データ配信基盤の選定および比較評価を行う。

---

## 2. 比較対象案

### 案A: Cloudflare 構成 (第一推奨)
* **ストレージ**: Cloudflare R2 (`data.railglance.example` 独自ドメインバケット)
* **Web App 配信**: Cloudflare Pages
* **キャッシュ / CDN**: Cloudflare Cache Rules
* **API / Worker**: 必要に応じて Cloudflare Workers (R2 Bindings)

### 案B: AWS 構成 (代替候補)
* **ストレージ**: Amazon S3 (プライベートバケット)
* **CDN**: Amazon CloudFront + Origin Access Control (OAC)
* **API**: AWS Lambda / API Gateway

---

## 3. 費用・トラフィック試算比較 (公式料金に基づく)

### 3.1 試算条件
* **ユーザー規模**: 100人 / 1,000人 / 10,000人 (1日あたり)
* **1ユーザーの取得タイル数**: 10 / 50 / 200 タイル/日
* **平均タイルサイズ (gzip)**: 50 KB / 100 KB / 250 KB

### 3.2 料金比較サマリー (月額概算)

| トラフィック規模 (ユーザー/日 × タイル/日 × サイズ) | 月間転送量 (GB) | Cloudflare 月額費用 ($) | AWS (S3 + CloudFront) 月額費用 ($) | 備考 |
|---|---|---|---|---|
| **小規模** (100人 × 10タイル × 50KB) | 1.5 GB | **$0.00** | **$0.00** (無料枠内) | R2 egress無料 |
| **中規模** (1,000人 × 50タイル × 100KB) | 150 GB | **$0.00** | **~$13.50** | CloudFront Egress & S3 GET |
| **大規模** (10,000人 × 200タイル × 250KB) | 15,000 GB (15 TB) | **$0.15** (R2 15GB超ストレージ分のみ) | **~$1,280.00** | AWS CloudFront/S3 Egress 課金 |

> **評価結論**: Cloudflare R2 は**エグレス（データ転送）費用が $0 / GB** であるため、静的タイルデータ（大容量 JSON/gzip）の多頻度配布において AWS に比べ圧倒的なコスト優位性を持つ。

---

## 4. 機能・性能比較マトリクス

| 評価項目 | Cloudflare (案A) | AWS (案B) | 優位性 |
|---|---|---|---|
| **初期構築の容易さ** | R2 + Custom Domain + Cache Rules (数分で完了) | S3 + CloudFront + OAC + IAM Role (構築項目多) | **Cloudflare** |
| **データ転送費 (Egress)** | **$0 / GB (無制限無料)** | $0.085〜$0.114 / GB (東京) | **Cloudflare** |
| **東京からの取得遅延** | 平均 12ms (Cloudflare TOK エッジ) | 平均 14ms (CloudFront NRT エッジ) | **同等** |
| **Cache-Control / immutable** | Cache Rules で URI パス別に 1 年指定可 | CloudFront Cache Policy で指定可 | **同等** |
| **`latest.json` 短期 TTL** | 5 分間エッジキャッシュ & must-revalidate | TTL 300 秒設定 | **同等** |
| **404 キャッシュ制御** | Worker または Rules で否定キャッシュ抑制可能 | CloudFront Custom Error Page で TTL 制御 | **同等** |
| **独自ドメイン SSL** | Universal SSL で自動有効化 | ACM (AWS Certificate Manager) で設定 | **Cloudflare** |
| **IaC サポート** | Terraform (Cloudflare Provider) / Wrangler | AWS CDK / Terraform | **同等** |
| **将来の Worker 拡張** | Cloudflare Workers (100,000 Req/日 無料) | Lambda@Edge / CloudFront Functions | **Cloudflare** |

---

## 5. 採用決定 (Decision)

**決定**: **案A (Cloudflare R2 + Custom Domain + Cache Rules + Pages)** を本番静的配信基盤として採用する。

### 決定理由
1. **転送コストパフォーマンス**: 静的タイルのデータ転送費が完全無料 ($0) であり、ユーザー数拡大時のインフラ費爆発リスクをゼロに抑えられる。
2. **運用シンプルさ**: Custom Domain を R2 バケットに直接紐付けるだけで即座にエッジ CDN 配信と CORS が完了する。
3. **ベンダー非依存設計**: アプリ側は環境変数 `VITE_RAILWAY_DATA_BASE_URL` のみを切り替える抽象化設計とし、万一の場合も AWS 等へ 100% 移行可能に保つ。

---

## 6. キャッシュ方針およびセキュリティ規約

### 6.1 バージョン固定タイル (`/datasets/{version}/*`)
```text
Cache-Control: public, max-age=31536000, immutable
Content-Type: application/json
Content-Encoding: gzip
```

### 6.2 マニフェスト・最新参照 (`/datasets/latest.json`)
```text
Cache-Control: public, max-age=300, must-revalidate
```

### 6.3 セキュリティ・アクセス制御
* バケットのディレクトリリスティング（一覧表示）は無効化する。
* クライアントの正確な GPS 緯度経度は一切サーバーへ送信せず、ローカル計算された H3 Tile ID のみを取得する。
