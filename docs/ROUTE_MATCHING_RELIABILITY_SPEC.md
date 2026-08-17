# 路線マッチング信頼性仕様

作成日: 2026-08-16

本書は、RailGlanceにおける路線誤検知の低減、誤検知後の自動再取得、手動再検出・手動ロックの仕様と実装方針を定める。

関連ドキュメント:

- `docs/GPS_LOSS_SPEED_STATE_SPEC.md` — GPS劣化・消失時の速度状態と再取得
- `docs/TELEMETRY_AND_SENTRY.md` — 実走ログ、候補スコア、Route Health、切替理由の収集
- `docs/HUD_UI_UX_REQUIREMENTS.md` — 路線判定中・再取得中のHUD表示

対象リポジトリ:

```text
https://github.com/TakuroFukamizu/railglance
```

---

# 1. 背景

Even G2実機テスト中、JR中央・総武線各駅停車の浅草橋駅付近にいるにもかかわらず、RailGlanceが「東北新幹線 東京〜上野間」と判定する事象が確認された。

さらに、浅草橋から秋葉原まで実際に中央・総武線で移動しても誤判定が解消せず、東北新幹線判定が継続した。

本件について、以下の3観点から改善を行う。

- A. 初回の誤検知を減らす
- B. 誤検知後に自動で異常を検知し、再判定・訂正できるようにする
- C. ユーザーが手動で路線再検出を実行できるようにする

ただし、A/Bの自動補正を強くしすぎると、正常な路線判定まで頻繁に揺れるリスクがある。

そのため、今回の実装では以下を最優先する。

> 「誤判定を無理に即時訂正する」よりも、  
> 「正常判定を不用意に壊さない」「確信が弱い場合は未確定状態を維持する」ことを優先する。

---

# 2. 現行実装で特に確認すべき問題

現行`MapMatcher`、`candidate-scorer`、`TrackingConfig`を確認した上で作業すること。

現状コードでは特に以下の点に注意する。

## 2.1 初回候補を即時確定している

`currentMatch === null`の場合、最高スコア候補をその場で採用している。

これにより、起動直後の単発GPS誤差や都市部の並走路線によって誤った路線が確定しやすい。

---

## 2.2 現在保持中のroute候補が、現在GPS fixで再評価されていない可能性

路線切替判定では、新しいGPS fixから得た`topCandidate`と、過去に保持した`currentMatch`を比較している。

`currentMatch.totalScore`や`currentMatch.distanceMeters`が過去fix時点の値であれば、

```text
新候補 = 現在位置での評価
現在候補 = 過去位置での評価
```

という不適切な比較になる。

これは今回の誤判定固着の主要原因になり得る。

**最優先で確認・修正すること。**

---

## 2.3 continuity bonusが誤判定の固定化を招く可能性

現在路線・現在segmentへ最大20点のcontinuity bonusが付与される。

一度誤ったrouteを選ぶと、その誤routeが継続的に有利になる可能性がある。

continuity自体は路線判定の安定化に必要なため削除しない。

ただし、

- 現在routeが矛盾している
- challengerが継続的に優勢
- route進行が不自然

といった状況ではcontinuity biasを弱める仕組みを導入する。

---

## 2.4 検索範囲とGPS精度許容値

現状の設定値が以下である場合は、都市部の高密度鉄道路線では候補が多くなる。

```text
routeSearchRadiusMeters = 1000m
maxGpsAccuracyMeters = 500m
```

これらを即座に単純縮小して解決してはならない。

地下、ビル街、駅周辺ではGPS精度が悪化するため、単純な閾値縮小は真の路線を除外する恐れがある。

距離閾値だけでなく、accuracy、heading、trajectory、route continuityを組み合わせること。

---

# 3. 全体設計方針

MapMatcherを以下の状態モデルへ発展させる。

```ts
export type RouteLockState =
  | 'UNRESOLVED'
  | 'LOCKED'
  | 'SUSPICIOUS'
  | 'REACQUIRING'
  | 'MANUAL_LOCK';
```

基本遷移:

```text
UNRESOLVED
   ↓
LOCKED
   ↓
SUSPICIOUS
   ↓
REACQUIRING
   ↓
LOCKED
```

手動選択時:

```text
REACQUIRING
   ↓
MANUAL_LOCK
```

手動解除:

```text
MANUAL_LOCK
   ↓
UNRESOLVED
```

---

# 4. A. 初回誤検知を減らす

## 4.1 現在候補を毎GPS fixで必ず再スコアする

最優先修正。

現在保持しているroute / segmentについて、毎GPS fixで現在位置から再評価する。

例:

```ts
const rescoredCurrent = candidateScores.find(
  candidate =>
    candidate.segment.id === this.currentMatch?.segment.id
);
```

存在しない場合は、現在routeが現在検索範囲から外れたものとして扱う。

比較は必ず以下とする。

```text
top challenger at current fix
vs
current route rescored at current fix
```

過去fix時点の`currentMatch.totalScore`を現在の切替判定に使用してはならない。

---

## 4.2 初回確定を即決しない

`UNRESOLVED`状態を導入する。

初回GPS fixだけでは路線を確定しない。

候補履歴を蓄積し、以下の複数条件を満たした場合のみ`LOCKED`へ移行する。

候補条件例:

```text
最低3〜5 GPS fix
AND
一定時間継続
AND
top candidateが複数回優勢
AND
topとsecondのscore marginが十分
```

ただし、ユーザーが停車中の場合は移動距離条件を必須にしない。

停止中に無理にrouteを確定する必要もない。

HUD上は速度を表示しつつ、

```text
路線判定中
```

と表示できるようにする。

---

## 4.3 1位と2位のscore marginを明示的に使う

次を計算する。

```ts
const scoreMargin =
  topCandidate.totalScore -
  (secondCandidate?.totalScore ?? 0);
```

単にtop candidateの絶対スコアだけで判断しない。

例:

```text
A = 78
B = 77
```

は確信度が低い。

```text
A = 91
B = 52
```

は強い。

閾値は設定値として管理する。

例:

```ts
routeInitialLockMinScore
routeInitialLockMinMargin
routeInitialLockConsecutiveCount
routeInitialLockMinimumMs
```

値は実走ログに基づき調整可能にする。

---

## 4.4 continuity判定をトポロジーベースへ変更する

ID文字列のprefixなどによる「同一路線っぽい」判定は避ける。

continuity bonusは以下の順で付与する。

```text
同一segment
> 隣接segment
> 同一route上で到達可能なsegment
> 同一路線だが非連続
> 無関係route
```

例:

```text
same segment: +20
adjacent segment: +15
reachable same route: +8
same line but disconnected: +2
different route: 0
```

数値は設定可能にする。

---

## 4.5 trajectory headingを導入する

単発の`sample.headingDegrees`だけに依存しない。

直近GPS履歴から、移動方向を求める。

例:

```text
5〜15秒
または
最低30〜50m移動
```

から代表headingを計算する。

優先順位:

```text
移動ベクトルから得たtrajectory heading
>
GPS提供heading
>
heading不明
```

低速時はtrajectory headingも信頼しすぎない。

---

## 4.6 線路距離をGPS accuracyと組み合わせる

単純な線路までの距離だけでなく、

```ts
normalizedDistance =
  distanceMeters /
  Math.max(accuracyMeters, minimumAccuracyMeters);
```

を補助評価に使う。

ただし、これをハード除外条件にしない。

都市部のmultipathや地下出口ではaccuracy値自体も不安定なため、penalty / confidence補正として使う。

---

## 4.7 駅順序は補助証拠として使う

駅付近・駅通過時に、

```text
previousStation
nextStation
trajectory
route progression
```

の整合性を評価する。

例:

```text
浅草橋付近
↓
西方向移動
↓
秋葉原付近
```

という動きが中央・総武線route上で自然に説明できるなら、そのrouteを強く支持できる。

ただし、大規模駅・並走区間では駅近接だけでrouteを確定しない。

---

## 4.8 速度情報は非対称に利用する

以下のようなルールは禁止。

```text
低速だから新幹線ではない
```

新幹線も駅付近では低速・停止するため。

一方、

```text
250km/hだから一般在来線ではない
```

は強い証拠として使える。

したがって速度は、

```text
物理的に不可能な高速 → 強いpenalty
低速 → 基本的にroute否定材料にしない
```

とする。

---

# 5. B. 誤検知を自動発見・訂正する

## 5.1 Route Healthを導入する

現在選択中routeが、現在の観測列をどの程度説明できているかを継続評価する。

例:

```ts
export type RouteHealth = {
  distanceConsistency: number;
  headingConsistency: number;
  trajectoryConsistency: number;
  stationSequenceConsistency: number;
  topologyConsistency: number;
  progressConsistency: number;
  challengerDominance: number;

  total: number;
};
```

各項目は0〜1など正規化した値とする。

---

## 5.2 route progress monotonicityを評価する

現在routeへ各GPS点を投影し、

```text
distanceFromRouteStartMeters
```

の時系列を見る。

正常例:

```text
12.30km
12.45km
12.62km
12.81km
```

誤routeの可能性が高い例:

```text
2.10km
1.82km
2.25km
1.91km
```

進行方向が一定なのにroute positionが大きく前後する場合、current route healthを低下させる。

ただし、以下を考慮する。

- 停車
- GPS jitter
- 方向転換
- 折返し運転
- route分岐

単一サンプルで異常判定しない。

---

## 5.3 SUSPICIOUS状態

route healthが悪化しても即座にrouteを変更しない。

以下のような条件で`SUSPICIOUS`へ遷移する。

```text
current route health < threshold
AND
一定時間継続
```

または、

```text
challengerがcurrentより一定margin以上優勢
AND
複数fix継続
```

`SUSPICIOUS`状態では現在routeを一応維持する。

HUDで必要なら、

```text
路線確認中
```

程度を表示する。

---

## 5.4 continuity bonusを状態に応じて弱める

例:

```text
LOCKED:
通常continuity

SUSPICIOUS:
continuityを25〜50%へ低下

REACQUIRING:
continuityを0〜最小値へ低下
```

これにより、通常時の安定性は維持しつつ、誤route固着時のみ再探索しやすくする。

---

## 5.5 Challenger方式

現在route以外の有力候補を`challenger`として追跡する。

例:

```ts
export type RouteChallengerState = {
  segmentId: string;
  routeId: string | null;

  consecutiveWins: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;

  latestScore: number;
  latestMargin: number;
};
```

切替条件は最低でも以下を満たす。

```text
1. current route healthが低い
2. challengerがcurrentより明確に高い
3. それが時間的に継続している
```

どれか1つだけで自動切替してはならない。

---

## 5.6 REACQUIRING状態

SUSPICIOUSが一定時間続いた場合のみ`REACQUIRING`へ遷移する。

この状態では、

- current continuity biasをほぼ無効化
- 直近GPS履歴を再評価
- candidate Top Nを比較
- trajectory整合性を重視

する。

1fixでrouteを切り替えない。

---

## 5.7 Sliding Window Map Matching

直近10〜20秒程度のGPSサンプル履歴を保持する。

候補routeごとに履歴全体を投影し、以下を評価する。

```text
平均線路距離
最大線路距離
trajectory heading整合
route position単調性
速度一貫性
駅順序整合
topology continuity
```

例:

```ts
export type WindowRouteScore = {
  routeId: string;

  meanDistanceScore: number;
  headingConsistencyScore: number;
  progressMonotonicityScore: number;
  stationSequenceScore: number;
  topologyScore: number;

  totalScore: number;
};
```

初回実装ではHMM/Viterbiなどの複雑な確率モデルは必須にしない。

まずwindow scoring方式を導入する。

---

## 5.8 自動訂正条件は保守的にする

自動切替は以下の三重条件とする。

```text
A. current route contradiction
AND
B. challenger superiority
AND
C. temporal persistence
```

さらに必要なら、

```text
GPS accuracyが一定以上良好
OR
trajectory distanceが十分
```

を追加する。

自動訂正後も新routeを即完全LOCKEDにせず、

```text
REACQUIRING
↓
数fix安定
↓
LOCKED
```

とする。

---

# 6. C. 手動再検出

スマートフォン画面に以下を追加する。

```text
路線を再検出
```

Even G2上に操作UIを追加する必要はない。

---

## 6.1 resetだけで終わらせない

単純な、

```ts
mapMatcher.reset();
```

だけでは不十分。

同じGPS点で同じ誤判定を再度選ぶ可能性がある。

---

## 6.2 Manual Reacquire

ボタン押下時は以下を行う。

```text
1. current route lock解除
2. continuity biasを0
3. 状態をREACQUIRINGへ変更
4. 直近10〜20秒のGPS履歴を利用
5. Top N候補をwindow scoring
6. 数fix観測
7. 新routeを確定
```

手動再検出中でも速度表示は継続する。

---

## 6.3 候補選択UI

再検出後、候補が拮抗している場合はユーザーが選択できるようにする。

例:

```text
路線候補

1. JR中央・総武線各駅停車  88%
2. JR山手線                  54%
3. 東北新幹線                31%
```

ユーザーが候補をタップした場合は`MANUAL_LOCK`とする。

---

## 6.4 MANUAL_LOCK

手動選択されたrouteを一定期間優先する。

設定例:

```text
session中
または
30分
または
ユーザーが解除するまで
```

ただし、現在位置が選択routeから明らかに離れた場合は、

```text
選択した路線から離れています
```

と警告する。

自動で即解除しない。

---

## 6.5 手動ロック解除

以下を用意する。

```text
自動判定に戻す
```

押下後:

```text
MANUAL_LOCK
↓
UNRESOLVED
↓
通常の初回確定処理
```

とする。

---

# 7. 新規設定項目

閾値をハードコードしない。

例:

```ts
export type RouteMatchingConfig = {
  initialLockMinScore: number;
  initialLockMinMargin: number;
  initialLockConsecutiveCount: number;
  initialLockMinimumMs: number;

  suspiciousHealthThreshold: number;
  suspiciousMinimumMs: number;

  reacquireMinimumMs: number;

  challengerMinMargin: number;
  challengerConsecutiveCount: number;
  challengerMinimumMs: number;

  trajectoryWindowMs: number;
  trajectoryMinDistanceMeters: number;

  manualLockMaxDistanceMeters: number;
};
```

既存`TrackingConfig`へ統合してもよい。

---

# 8. Telemetry / Debugログ

今回の改善は実走ログによる調整を前提とする。

既存のTelemetry実装がある場合は必ず連携する。

最低限以下を記録する。

## 毎fix

```text
GPS lat/lon
GPS accuracy
GPS speed
GPS heading
trajectory heading

current route
current segment
current score
current rescored score

top candidate
second candidate
score margin

candidate Top5:
  distance
  distanceScore
  headingScore
  continuityScore
  historyScore
  totalScore

route health各要素
route health total

challenger
challenger wins
challenger duration

RouteLockState

switch reason
```

---

## 状態遷移イベント

以下は個別イベントとして保存する。

```text
route-lock
route-suspicious
route-reacquire-start
route-switch
manual-reacquire
manual-route-lock
manual-route-unlock
route-lost
```

`route-switch`には必ず理由を記録する。

例:

```ts
type RouteSwitchReason =
  | 'initial-lock'
  | 'challenger-dominant'
  | 'route-health-low'
  | 'manual-selection'
  | 'manual-reacquire'
  | 'current-route-lost';
```

---

# 9. デバッグ画面

スマートフォンDebugPanelへ追加する。

```text
Route State
Current Route
Current Segment
Current Score
Current Score (rescored)
Top Candidate
Second Candidate
Score Margin

Route Health
Distance Consistency
Heading Consistency
Trajectory Consistency
Progress Consistency
Station Sequence Consistency

Challenger
Challenger Score
Consecutive Wins
Duration

Trajectory Heading
Trajectory Window

Manual Lock State
```

開発中は候補Top5を展開表示できるようにする。

---

# 10. テスト

## 10.1 Initial Lock

- 1fixだけで確定しない
- 同一候補が継続するとLOCKEDになる
- top/secondが僅差ならUNRESOLVEDを維持
- 停止中でも誤ったrouteを即確定しない

---

## 10.2 Current Rescore

- current routeが毎fix再評価される
- 過去fixのscoreを切替比較に使わない
- current routeが検索範囲から消えた場合を処理できる

---

## 10.3 Continuity

- 同一segmentが最も高いbonus
- 隣接segmentは適度なbonus
- 非連続の同一路線segmentへ高bonusを付けない
- SUSPICIOUSでbonusが下がる
- REACQUIRINGでbiasがほぼ消える

---

## 10.4 Route Health

- route positionが滑らかなら高health
- route positionが前後ジャンプするとhealth低下
- heading不一致が継続するとhealth低下
- 単発GPS外れ値だけではSUSPICIOUSにならない

---

## 10.5 Challenger

- 一瞬だけ高scoreのcandidateでは切替しない
- 複数fix継続したcandidateを追跡する
- current healthが正常ならchallengerだけで切替しない
- current health低下 + challenger優勢 + 継続で切替する

---

## 10.6 Manual Reacquire

- ボタン押下でcontinuity biasが解除される
- 過去GPS windowを使って再評価する
- 速度表示は停止しない
- 候補が拮抗する場合は候補選択できる

---

## 10.7 Manual Lock

- ユーザー選択routeが優先される
- 近傍の別routeへ勝手に切替しない
- 大きく離れた場合に警告する
- 自動判定へ戻せる

---

# 11. 実走再現テスト

今回の浅草橋ケースをfixture化する。

最低限以下のログを再生できるテストデータを作る。

```text
浅草橋駅付近で開始
↓
中央・総武線各駅停車に乗車
↓
浅草橋 → 秋葉原
```

検証項目:

```text
東北新幹線が一時Top candidateになっても即LOCKしない

誤って東北新幹線LOCK状態から開始した場合:
  route healthが低下
  SUSPICIOUS
  REACQUIRING
  中央・総武線へ訂正

正常な中央・総武線LOCK後:
  並走候補が出ても不必要に揺れない
```

可能なら以下も追加する。

```text
東京〜上野の新幹線実走
```

これにより、浅草橋対策によって本当の東北新幹線判定を壊していないことを確認する。

---

# 12. 回帰テスト対象

誤判定対策により、以下を壊してはならない。

- 同一路線segment間の滑らかな遷移
- 新幹線高速走行判定
- GPS精度劣化時のDR
- トンネル出口のreacquire
- 駅停車
- 並走区間
- Cloudflareから取得したrouteデータ
- Cached routeデータ
- Even G2速度表示
- HUD更新レート
- Telemetry送信

---

# 13. 実装順序

一度に全機能を混ぜない。

以下の順でコミットする。

## Step 1

current route再スコア修正。

```text
fix: rescore current route on every gps observation
```

## Step 2

初回即決廃止 + score margin。

```text
feat: add unresolved state and stable initial route locking
```

## Step 3

トポロジーベースcontinuity。

```text
refactor: score route continuity using track topology
```

## Step 4

trajectory heading。

```text
feat: add trajectory-based route heading evidence
```

## Step 5

Route Health。

```text
feat: monitor current route health
```

## Step 6

SUSPICIOUS / challenger / REACQUIRING。

```text
feat: add conservative automatic route reacquisition
```

## Step 7

手動再検出。

```text
feat: add manual route reacquire control
```

## Step 8

候補選択 / manual lock。

```text
feat: allow manual route selection and lock
```

## Step 9

Telemetry / DebugPanel / fixture。

```text
test: add Asakusabashi route misclassification regression scenario
```

---

# 14. 特に禁止する実装

以下のような単純修正は禁止する。

```text
新幹線は低速なら除外
```

```text
検索半径を一律200mへ縮小
```

```text
GPS accuracyが50m超なら路線判定しない
```

```text
別candidateが1回勝ったら即切替
```

```text
continuity bonusを完全削除
```

```text
毎fix完全resetして再判定
```

これらはいずれも特定ケースだけ改善して、別ケースの誤検知を増やす可能性が高い。

---

# 15. 完了条件

以下をすべて満たすこと。

## A. 誤検知低減

- current routeが毎fix再評価される
- 初回1fixでrouteを確定しない
- score marginを評価する
- trajectory evidenceを利用できる
- topologyベースcontinuityを利用する
- uncertain時にUNRESOLVEDを維持できる

## B. 自動訂正

- Route Healthを継続評価する
- 単発異常ではrouteを変更しない
- SUSPICIOUS状態を持つ
- challengerを時間的に追跡する
- current contradiction + challenger superiority + persistenceの三重条件で切替する
- 誤routeから自動復帰できる
- 正常routeが不用意に揺れない

## C. 手動訂正

- 「路線を再検出」がある
- 過去GPS windowを利用する
- continuity biasなしで再評価する
- 候補一覧から手動選択できる
- MANUAL_LOCKできる
- 自動判定へ戻せる

## Telemetry

- 候補Top5を記録する
- current routeの再スコアを記録する
- score marginを記録する
- Route Healthを記録する
- challenger状態を記録する
- route switch reasonを記録する

## テスト

- 浅草橋→秋葉原fixtureがある
- 誤った東北新幹線初期LOCKから中央・総武線へ復帰できる
- 本当の東北新幹線走行を壊していない
- 既存テストが成功する
- buildが成功する

---

# 16. 作業報告

完了時は以下を報告する。

```text
原因分析:
- ...

実装したA対策:
- ...

実装したB対策:
- ...

実装したC対策:
- ...

Route Healthの判定内容:
- ...

自動切替条件:
- ...

手動再検出仕様:
- ...

追加Telemetry:
- ...

追加テスト:
- ...

浅草橋fixture結果:
- ...

既存ケースへの回帰結果:
- ...

実機未確認事項:
- ...

今後調整が必要な閾値:
- ...
```

閾値の値は、推測だけで最適値と断定しない。

実走Telemetryを用いて今後調整できる状態を維持すること。
