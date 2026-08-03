# 関東圏 鉄道データカバレッジレポート (v1.0.0)

* **生成日時**: 2026-08-03T10:18:58.221Z
* **対象地域**: 1都6県 (東京都, 神奈川県, 埼玉県, 千葉県, 茨城県, 栃木県, 群馬県) ＋ 県境30km/3駅バッファ

---

## 1. 総括メトリクス

| 項目 | 統計値 |
|---|---|
| **対象事業者数** | 26 |
| **対象路線数** | 62 |
| **総収録駅数** | 66 |
| **総駅間セグメント数** | 53 |
| **生成H3タイル数** | 24 |
| **ポリライン欠落路線** | 54 |
| **トポロジー不整合数** | 0 |
| **手動補正箇所数** | 1 |

---

## 2. 収録路線詳細一覧 (62 路線)

| 路線ID | 路線名 | 事業者 | 駅数 | セグメント数 | 線形ポリライン |
|---|---|---|---|---|---|
| `odakyu-odawara` | **小田急本線** | 小田急電鉄 | 20 | 14 | ✓ あり |
| `jreast-tohoku-shinkansen` | **JR東北新幹線** | jreast | 11 | 10 | ✓ あり |
| `jreast-joetsu-shinkansen` | **JR上越新幹線** | jreast | 6 | 5 | ✓ あり |
| `jreast-hokuriku-shinkansen` | **JR北陸新幹線** | jreast | 5 | 4 | ✓ あり |
| `keikyu-main-line` | **京急空港線・本線** | keikyu | 7 | 6 | ✓ あり |
| `sotetsu-main-line` | **相鉄本線** | sotetsu | 5 | 4 | ✓ あり |
| `jreast-yokohama-line` | **JR横浜線** | jreast | 7 | 6 | ✓ あり |
| `jr-yamanote` | **JR山手線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-chuo-rapid` | **JR中央線快速** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-chuo-sobu` | **JR中央・総武線各駅停車** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-tokaido` | **JR東海道線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-keihin-tohoku` | **JR京浜東北・根岸線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-shonan-shinjuku` | **JR湘南新宿ライン** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-joban` | **JR常磐線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-takasaki` | **JR高崎線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-utsunomiya` | **JR宇都宮線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-saikyo` | **JR埼京線・川越線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-musashino` | **JR武蔵野線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-nambu` | **JR南武線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-yokohama` | **JR横浜線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-keiyo` | **JR京葉線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-sobu-quick` | **JR総武快速線** | JR東日本 | 0 | 0 | ✕ なし |
| `jr-chuo-main` | **JR中央本線 (大月・甲府方面)** | JR東日本 | 0 | 0 | ✕ なし |
| `shinkansen-tokaido` | **東海道新幹線** | JR東海 | 0 | 0 | ✕ なし |
| `shinkansen-tohoku` | **東北新幹線** | JR東日本 | 5 | 4 | ✓ あり |
| `shinkansen-joetsu` | **上越新幹線** | JR東日本 | 0 | 0 | ✕ なし |
| `shinkansen-hokuriku` | **北陸新幹線** | JR東日本 | 0 | 0 | ✕ なし |
| `tokyo-metro-ginza` | **東京メトロ銀座線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-marunouchi` | **東京メトロ丸ノ内線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-hibiya` | **東京メトロ日比谷線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-tozai` | **東京メトロ東西線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-chiyoda` | **東京メトロ千代田線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-yurakucho` | **東京メトロ有楽町線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-hanzomon` | **東京メトロ半蔵門線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-namboku` | **東京メトロ南北線** | 東京メトロ | 0 | 0 | ✕ なし |
| `tokyo-metro-fukutoshin` | **東京メトロ副都心線** | 東京メトロ | 0 | 0 | ✕ なし |
| `toei-asakusa` | **都営浅草線** | 東京都交通局 | 0 | 0 | ✕ なし |
| `toei-mita` | **都営三田線** | 東京都交通局 | 0 | 0 | ✕ なし |
| `toei-shinjuku` | **都営新宿線** | 東京都交通局 | 0 | 0 | ✕ なし |
| `toei-oedo` | **都営大江戸線** | 東京都交通局 | 0 | 0 | ✕ なし |
| `yokohama-subway-blue` | **横浜市営地下鉄ブルーライン** | 横浜市交通局 | 0 | 0 | ✕ なし |
| `yokohama-subway-green` | **横浜市営地下鉄グリーンライン** | 横浜市交通局 | 0 | 0 | ✕ なし |
| `tokyu-toyoko` | **東急東横線** | 東急電鉄 | 0 | 0 | ✕ なし |
| `tokyu-denentoshi` | **東急田園都市線** | 東急電鉄 | 0 | 0 | ✕ なし |
| `keikyu-main` | **京急本線** | 京浜急行電鉄 | 0 | 0 | ✕ なし |
| `keio-main` | **京王線** | 京王電鉄 | 0 | 0 | ✕ なし |
| `seibu-ikebukuro` | **西武池袋線** | 西武鉄道 | 0 | 0 | ✕ なし |
| `seibu-shinjuku` | **西武新宿線** | 西武鉄道 | 0 | 0 | ✕ なし |
| `tobu-skytree` | **東武スカイツリーライン・伊勢崎線** | 東武鉄道 | 0 | 0 | ✕ なし |
| `tobu-tojo` | **東武東上線** | 東武鉄道 | 0 | 0 | ✕ なし |
| `sotetsu-main` | **相鉄本線** | 相模鉄道 | 0 | 0 | ✕ なし |
| `keisei-main` | **京成本線** | 京成電鉄 | 0 | 0 | ✕ なし |
| `yurikamome` | **ゆりかもめ東京臨海新交通臨海線** | ゆりかもめ | 0 | 0 | ✕ なし |
| `tokyo-monorail` | **東京モノレール羽田空港線** | 東京モノレール | 0 | 0 | ✕ なし |
| `tama-monorail` | **多摩都市モノレール線** | 多摩都市モノレール | 0 | 0 | ✕ なし |
| `enoden` | **江ノ島電鉄線** | 江ノ島電鉄 | 0 | 0 | ✕ なし |
| `shonan-monorail` | **湘南モノレール江の島線** | 湘南モノレール | 0 | 0 | ✕ なし |
| `utsunomiya-lrt` | **宇都宮芳賀ライトレール線** | 宇都宮ライトレール | 0 | 0 | ✕ なし |
| `tx-tsukuba-express` | **つくばエクスプレス** | 首都圏新都市鉄道 | 0 | 0 | ✕ なし |
| `chichibu-railway` | **秩父本線** | 秩父鉄道 | 0 | 0 | ✕ なし |
| `jomo-electric-railway` | **上毛線** | 上毛電気鉄道 | 0 | 0 | ✕ なし |
| `kanto-railway-joso` | **関東鉄道常総線** | 関東鉄道 | 0 | 0 | ✕ なし |

---

## 3. データ出典およびライセンス情報

* **mlit-n02-23** (MLIT-NLKPI-Terms): 「国土数値情報（鉄道データ N02-23）」（国土交通省）を加工して作成
* **railglance-existing-sample** (MIT): RailGlance Core Team
