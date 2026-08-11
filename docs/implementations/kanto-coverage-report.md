# 関東圏 鉄道データ配信対象レポート (v1.1.0)

* **生成日時**: 2026-08-05T02:19:12.464Z
* **抽出対象地域**: 1都6県 (東京都, 神奈川県, 埼玉県, 千葉県, 茨城県, 栃木県, 群馬県) ＋ 県境バッファ
* **収録条件**: 駅2件以上・駅間線形1件以上を持ち、トポロジー品質ゲートを通過した路線のみ

---

## 1. 総括メトリクス

| 項目 | 統計値 |
|---|---|
| **対象事業者数** | 4 |
| **対象路線数** | 7 |
| **総収録駅数** | 56 |
| **総駅間セグメント数** | 49 |
| **生成H3タイル数** | 254 |
| **ポリライン欠落路線** | 0 |
| **トポロジー不整合数** | 0 |
| **手動補正箇所数** | 1 |

---

## 2. 収録路線詳細一覧 (7 路線)

| 路線ID | 路線名 | 事業者 | 駅数 | セグメント数 | 線形ポリライン |
|---|---|---|---|---|---|
| `odakyu-odawara` | **小田急本線** | odakyu | 15 | 14 | ✓ あり |
| `jreast-tohoku-shinkansen` | **JR東北新幹線** | jreast | 11 | 10 | ✓ あり |
| `jreast-joetsu-shinkansen` | **JR上越新幹線** | jreast | 6 | 5 | ✓ あり |
| `jreast-hokuriku-shinkansen` | **JR北陸新幹線** | jreast | 5 | 4 | ✓ あり |
| `keikyu-main-line` | **京急空港線・本線** | keikyu | 7 | 6 | ✓ あり |
| `sotetsu-main-line` | **相鉄本線** | sotetsu | 5 | 4 | ✓ あり |
| `jreast-yokohama-line` | **JR横浜線** | jreast | 7 | 6 | ✓ あり |

---

## 3. データ出典およびライセンス情報

* **railglance-existing-sample** (MIT): RailGlance Core Team
* **manual-corrections** (MIT): RailGlance Manual Curations
