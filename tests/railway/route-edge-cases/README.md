# 路線判定エッジケース回帰テスト

並走・分離・合流で路線判定が揺れやすい区間を、実データの線形と決定的な合成GPSで再現し、
`MapMatcher` のロジック変更でデグレが起きていないかを確認するテスト群です。

```bash
pnpm test:route-edge        # このテストだけ実行
pnpm test:route-edge -u     # ベースライン（スナップショット）を意図して更新する
pnpm fixture:route-edge     # データセット更新時にフィクスチャを再生成する
```

## 対象区間（`scenarios.ts`、各シナリオは逆方向も実行）

| シナリオ | 揺れやすい理由 |
| --- | --- |
| `tabata-fork-yamanote` / `tabata-fork-keihin-tohoku` | 山手線と京浜東北線が日暮里〜田端で並走し、田端で西（駒込）と北（上中里）に分離。北側は東北新幹線・尾久経由の東北線とも近接 |
| `shinagawa-fork-yamanote` / `shinagawa-fork-keihin-tohoku` | 田町〜品川で並走し、品川南の御殿山で山手線（大崎）と東海道線（大井町）に分離。京急本線・東海道新幹線も近接 |
| `tokyo-shinagawa-keihin-tohoku` / `tokyo-shinagawa-tokaido-rapid` | 東京〜品川で東海道新幹線と並走。在来線で新幹線と判定しないこと |
| `tokyo-shinagawa-tokaido-shinkansen` | 同区間を新幹線で走行（約110km/hなので速度ペナルティでは区別できず、線形のみで判定） |
| `tokyo-ueno-keihin-tohoku` | 東京〜上野で東北新幹線（MLIT線形＋同梱サンプルの直線近似）と並走 |
| `ochanomizu-ryogoku-sobu-local` | 中央線から御茶ノ水で総武線各駅停車区間へ入り、両国で総武本線（快速線）と合流 |
| `ryogoku-sobu-rapid` | 総武快速線 東京〜馬喰町の地下区間（GPS劣化）から両国通過で各駅停車線と合流 |

## 仕組み

- `fixtures/tokyo-core-corridors.json` — 公開データセット v1.4.0 の H3 タイルから、対象区間の線路から1.6km以内の全路線（地下鉄等を含む）を切り出したもの。
  「国土数値情報（鉄道データ N02-23）」（国土交通省）を加工して作成。
  - v1.4.0 には東海道新幹線 東京〜品川が存在しないため、東海道線の線形を東へ35mずらした**合成セグメント**を追加している（`meta.notes` 参照）。
- `fixture-db.ts` — 本番の `DexieRailwayDatabase.findSegmentsNear`（頂点が半径×1.5以内）と同じ抽出条件のインメモリDB。
- `trace.ts` — 区間ごとに台形速度（加減速0.7m/s²）、駅停車（速度≈0・方位なし）、横方向ノイズσ6m、精度8〜15mの1Hz GPSをシード付き乱数で生成。データの欠落区間は直線で補間する。
  セグメント端点は分岐点など駅から数百m離れていることがあるため、停車位置は駅座標（50m以上離れていれば駅まで延長）に合わせる。
- `runner.ts` — `DEFAULT_TRACKING_CONFIG` のまま `MapMatcher` に流し、HUDに表示される路線（`shouldDisplaySelectedRoute`）を1秒ごとに評価する。

## 判定の2層構造

1. **ハードチェック**（シナリオごと）
   - `no-forbidden-line`: 並走する新幹線など、禁止路線を一度も表示しない
   - `correct-final-line`: 最後の区間で許容路線を表示して終わる
   - `no-wrong-line`: 区間開始から45秒（`DEFAULT_SETTLE_S`）経過後に許容外の路線を表示しない
   MLITデータは1本の線路帯を複数の「路線」に分割しているため、区間ごとに許容路線を集合で指定する。
2. **ベースライン**（`__snapshots__/`）
   初回表示までの秒数、表示路線の遷移、ロック状態遷移、路線変更回数、誤表示秒数、区間ごとの内訳を記録する。

## 結果の読み方

- ハードチェックが新たに失敗した → **デグレ**。
- `[known issue]` のテストが失敗した → 既知の誤判定が**改善された**。`route-edge-cases.test.ts` の `KNOWN_ISSUES` から該当項目を削除し、`-u` でベースラインを更新する。
- スナップショットだけ差分が出た → 挙動が変化した。`wrongLineS` や `lineChanges` の増減を見て良し悪しを判断し、意図した変化であれば `-u` で更新する。

## シナリオを追加するとき

`scenarios.ts` の `FORWARD_SCENARIOS` に区間（`path` はセグメントID、または欠落を補う `[lat, lon]`）と許容路線を追加する。
新しい区間のセグメントがフィクスチャにない場合は、`src/scripts/build-route-edge-fixture.ts` の `CORRIDOR_SEGMENT_IDS` に追加して `pnpm fixture:route-edge` を実行する。
1.5km を超える直線補間は経路指定ミスとしてエラーになる。
