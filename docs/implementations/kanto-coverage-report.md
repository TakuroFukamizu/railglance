# 関東圏 鉄道データ配信対象レポート

従来の v1.0.0 レポートは、線形を持たない合成路線名まで「対象路線」に含めていたため無効とした。
現在の ETL は、公式 MLIT N02-23 GeoJSON または curated sample から取得した路線のうち、次の品質条件を
すべて満たす路線だけを manifest と H3 tile に収録する。

- 駅が2件以上ある
- 駅間 segment と実座標 polyline が1件以上ある
- station 接続グラフから順序を決定できる
- 分岐が曖昧な場合は公開せずビルドを失敗させる
- 環状線と不連続 component は明示的な route として生成できる

2026-08-04 に公式 `N02-23_RailroadSection.geojson` / `N02-23_Station.geojson` を使った未公開の
検証ビルドを実行し、167路線、2,317駅、2,151 segment、807個の H3 resolution 6 tile を生成できた。
これは公開 version ではなく、実データ変換と品質ゲートの検証結果である。

公開時は `DATASET_VERSION` と `MLIT_N02_DIR` を明示して `pnpm build:data` を実行する。生成された
`dist/railway-dataset/v${DATASET_VERSION}/coverage-report.json` と、このファイルへ出力される路線別レポートを
レビューしてから R2 の `latest.json` を切り替える。同じ version の再公開はデプロイ処理が拒否する。

データ出典: 「国土数値情報（鉄道データ N02-23）」（国土交通省）、CC BY 4.0。
