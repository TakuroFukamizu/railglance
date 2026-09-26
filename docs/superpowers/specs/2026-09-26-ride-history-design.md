# 乗車履歴の記録・一覧・エクスポート（Phone UI）

日付: 2026-09-26
ブランチ: `issue-63`
Issue: #63

## 目的

Phone UI 再構成（`docs/superpowers/specs/2026-09-08-phone-ui-redesign-design.md`）で枠だけ用意した
「乗車履歴」に中身を入れる。

- 路線判定の結果から乗車 1 回分（路線・方向・乗車駅・降車駅・時刻・距離）を自動で記録し、端末内に保存する。
- ホームの `#history-card-body` に直近の乗車を表示し、`#/history` ビューに一覧と各乗車の詳細を出す。
- 記録全体を JSON でエクスポートする。Even App WebView で使える手段は実行時に検出し、必ず動く手段
  （テキスト表示からの手動コピー）を最後に残す。
- 履歴は診断テレメトリ（Cloudflare R2）とは無関係に、同意の有無にかかわらず端末内だけに保存する。

## 決定事項と前提

Issue には決めていない点が多いので、本 spec で次のとおり決める。いずれも定数または純関数の差し替えで変えられる。

| 項目 | 決定 | 根拠 |
| --- | --- | --- |
| 乗車の開始判定 | 確定ロック中（`isCommittedRouteLock`）が 30 秒連続し、開始 tick は `journey.status === 'TRACKING'`、その間に 1 回以上「停止していない」tick があった | 路線のフラップで幽霊乗車を作らない。継続判定にはロック状態だけを使い、トンネル内の `GPS_UNAVAILABLE` で乗車を切らない |
| 乗車の終了判定 | (a) 確定ロックのまま別路線に変わった、(b) 確定ロックでない状態が 180 秒続いた、(c) 停止状態が 600 秒続いた、(d) 起動時に前回の未終了レコードが残っていた | 乗換・降車後の徒歩・終点での長時間停車・WebView 強制終了に対応する |
| 終了時刻 | (a)(b) は最後に確定ロックだった tick の時刻、(c) は停止が始まった tick の時刻、(d) は最終更新時刻 | タイムアウト満了時刻ではなく、乗っていた最後の時刻を残す |
| 最短乗車 | 2 分未満または 500 m 未満は保存しない | 駅間 1 区間の短い乗車（通常 2 分以上）は残し、誤検出は捨てる |
| 距離 | 確定ロック中の連続する GPS サンプル間の haversine 距離の総和。精度 100 m 超のサンプルと、隣接サンプル間 5 km 超の跳びは除外 | `trackPositionMeters` は区間切替でリセットされるので使わない |
| 駅名の保存 | 駅・路線は名前も保存し、ID だけに依存しない | `deleteInactiveRemoteVersions()` で古いデータセットの行が消える |
| 保持期間 | 90 日、または直近 500 件 | 個人の乗車ログとして十分な期間で、IndexedDB の肥大を防ぐ |
| エクスポート形式 | JSON 1 種類 | `docs/PHASE1_DEAD_RECKONING_REQUIREMENTS.md` 713 行目「IndexedDBへ保存し、JSONとして出力できること」 |
| エクスポート手段 | `navigator.share` → `navigator.clipboard.writeText` → `<textarea readonly>` 表示の順に実行時検出 | Even Hub SDK 0.0.12 に共有・クリップボード API はなく、WebView での可否は未確認 |
| テレメトリ | 履歴は `TelemetrySink` を一切通さず、同意状態も読まない | Issue の「テレメトリの同意とは独立させる」 |
| 言語 | 日本語のみ（既存 UI と同じ） | 英語ローカライズは別 Issue |

前提: 同梱サンプル路線は `stationDataComplete === false` なので駅が `null` になる。デモ再生では駅なしの乗車が記録される
（路線名・時刻・距離は入る）。方向は推定器が不明時に `'UP'` を既定にするため、`directionName` は既定値の可能性がある。

## 現状

- 乗車という概念はコードにない。`AppController.onRenderTick()` が 1 秒ごとに `EstimationLogEntry`
  （`rawLocation`、`speedState`、`match`、`journey`、`hudViewModel`）を `EstimationLogger.log()` に流し、
  `main.ts` は `logger.subscribe()` でそれを購読している。
- `JourneyState` は `line`、`directionName`、`previousStation`、`nextStation`（`Station` は `id` と `name` を持つ）、
  `status`、`lockState` を持つ。`FullSpeedState.isStopped` が停止判定。
- 永続化は Dexie/IndexedDB のみ（`RailGlanceDB`、`RailGlanceTelemetry`、`RailGlanceTelemetryControl`）。
  `IndexedDbTelemetryStore` がインターフェース + Dexie サブクラスの手本で、`prune(cutoff, maxEvents)` を持つ。
- `index.html` のホームには `#history-card-body`（`card-empty`）、`<section data-view="history">` には見出しと空状態だけがある。
- テストは Vitest の `environment: 'node'`。DOM 実装はない。`tests/setup.ts` が `fake-indexeddb/auto` を読み込む。

## 制約

- 実装は「純関数でビューモデルを組み立て、`main.ts` で DOM に流し込む」既存パターンに従う。
- DOM や `navigator` を触るコードは差し込み可能な最小インターフェースにし、手書きフェイクで検証する。
- WebView は前触れなく終了する。未終了の乗車は 30 秒以内に必ず IndexedDB に書いてあること。
- `innerHTML` を使うなら `src/ui/html.ts` の `escapeHtml` を通す。駅名・路線名は外部データ由来。

## データモデル

`src/domain/history/ride-record.ts`

```ts
export type RideEndReason = 'transfer' | 'route-lost' | 'stopped' | 'app-restart';

export type RideStationRef = { id: string; name: string };

export type RideRecord = {
  recordVersion: 1;
  id: string;                       // crypto.randomUUID()（無ければ時刻 + 乱数のフォールバック）
  status: 'open' | 'closed';
  lineId: string;
  lineName: string;
  operatorName: string | null;
  directionName: string | null;     // JourneyState.directionName
  fromStation: RideStationRef | null;
  toStation: RideStationRef | null;
  passedStations: RideStationRef[]; // previousStation が変わるたびに追記（from を含む、重複連続なし）
  startedAtMs: number;
  endedAtMs: number | null;         // open のあいだは null
  endReason: RideEndReason | null;
  distanceMeters: number;
  maxSpeedKmh: number | null;       // speedState.smoothedSpeedKmh の最大
  updatedAtMs: number;              // 最後に store へ書いた tick の時刻
};
```

## 乗車判定（純粋な reducer）

`src/domain/history/ride-recorder.ts`

入力は `EstimationLogEntry` から作る最小の tick:

```ts
export type RideTick = {
  timestampMs: number;
  committed: boolean;               // match !== null && isCommittedRouteLock(match.lockState) && journey.line !== null
  tracking: boolean;                // journey.status === 'TRACKING'（candidate の開始条件にだけ使う）
  line: { id: string; name: string; operatorName: string | null } | null;
  directionName: string | null;
  previousStation: RideStationRef | null;
  isStopped: boolean;               // speedState.isStopped
  speedKmh: number | null;          // speedState.smoothedSpeedKmh
  location: { latitude: number; longitude: number; accuracyMeters: number; timestampMs: number } | null;
};

export function toRideTick(entry: EstimationLogEntry): RideTick;
```

設定 `src/config/ride-history-config.ts`

```ts
export type RideHistoryConfig = {
  startConfirmMs: number;      // 30_000
  routeLostEndMs: number;      // 180_000
  stoppedEndMs: number;        // 600_000
  minRideDurationMs: number;   // 120_000
  minRideDistanceMeters: number; // 500
  maxSampleAccuracyMeters: number; // 100
  maxSampleJumpMeters: number; // 5_000
  persistIntervalMs: number;   // 30_000
  retentionMs: number;         // 90 日
  maxRecords: number;          // 500
  homeCardCount: number;       // 3
};
export const DEFAULT_RIDE_HISTORY_CONFIG: RideHistoryConfig;
```

状態機械

```
idle ──committed & tracking──▶ candidate ──30s 連続 committed & 非停止 tick あり──▶ riding
candidate ──非 committed──▶ idle（レコードは作らない）
riding ──別 lineId で committed──▶ close(transfer) → candidate（新路線、開始時刻はその tick）
riding ──非 committed が 180s──▶ close(route-lost)
riding ──停止が 600s──▶ close(stopped)
```

- `RideRecorderState` は `phase`、`record: RideRecord | null`、`candidateSinceMs`、`sawMovingTick`、`lostSinceMs`、
  `stoppedSinceMs`、`lastCommittedAtMs`、`lastLocation`、`lastPersistedAtMs` を持つ。
- `reduceRideTick(state, tick, config): { state, effects }`。effects は次のいずれか（複数可）:
  `{ type: 'persist', record }`（open レコードの書き込み）、`{ type: 'close', record }`（closed レコードの書き込み）、
  `{ type: 'discard', recordId }`（最短未満で捨てる。open レコードを書いた後なら削除）。
- `candidate` → `riding` に上がった時点で `record` を作る。`startedAtMs = candidateSinceMs`。`fromStation` は candidate 以降に
  最初に観測した非 `null` の `previousStation`。`passedStations` はそれ以降 `previousStation.id` が変わるたびに追記する。
- `riding` 中の committed tick で `line.id` が変われば `close(transfer)`。`endedAtMs = lastCommittedAtMs`（旧路線の最後の tick）。
  その tick から新路線の `candidate` を始める。
- 非 committed tick は `lostSinceMs` を立てる。`committed` に戻れば消す。`riding` 中に `timestampMs - lostSinceMs >= routeLostEndMs`
  なら `close(route-lost)`、`endedAtMs = lastCommittedAtMs`。
- `isStopped` が真なら `stoppedSinceMs` を立て、偽で消す。`riding` 中に `timestampMs - stoppedSinceMs >= stoppedEndMs` なら
  `close(stopped)`、`endedAtMs = stoppedSinceMs`。
- 距離: committed かつ `location` あり、`accuracyMeters <= maxSampleAccuracyMeters`、`lastLocation` から
  `timestampMs` が進んでいるとき、haversine を加算する。`maxSampleJumpMeters` 超の跳びは加算せず `lastLocation` だけ更新する。
  `lastLocation` は候補段階から追う（riding 昇格前の 30 秒分も距離に入れる）。
- `toStation` は close 時に「最後に観測した非 `null` の `previousStation`」。
- `persist` は riding 昇格時、`passedStations` が伸びた tick、前回 persist から `persistIntervalMs` 以上経った tick、close 時に出す。
- close 時に `endedAtMs - startedAtMs < minRideDurationMs` または `distanceMeters < minRideDistanceMeters` なら `discard`。
- `finalizeDanglingRecord(record, nowMs)`: 起動時に見つかった `status: 'open'` を `endedAtMs = record.updatedAtMs`、
  `endReason: 'app-restart'` で閉じる。最短未満なら `null` を返す（呼び出し側が削除）。

## 保存

`src/infrastructure/storage/ride-history-store.ts`

```ts
export type RideHistoryStore = {
  put(record: RideRecord): Promise<void>;
  get(id: string): Promise<RideRecord | undefined>;
  findOpen(): Promise<RideRecord[]>;
  listRecent(limit: number): Promise<RideRecord[]>;   // closed のみ、startedAtMs 降順
  listAll(): Promise<RideRecord[]>;                    // closed のみ、startedAtMs 降順（エクスポート用）
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  prune(cutoffStartedAtMs: number, maxRecords: number): Promise<void>; // 古い closed を消し、超過分は古い順に消す
  close(): void;
};

export class IndexedDbRideHistoryStore extends Dexie implements RideHistoryStore {
  constructor(databaseName = 'RailGlanceRideHistory');   // rides: 'id,startedAtMs,status'
}
export class InMemoryRideHistoryStore implements RideHistoryStore;  // テストとフォールバック用
```

`prune` は `open` を消さない。テストは `RailGlanceTest-${crypto.randomUUID()}` の DB 名を使う。

## 調停役

`src/app/ride-history-controller.ts`

```ts
export function createRideHistoryController(deps: {
  store: RideHistoryStore;
  config?: RideHistoryConfig;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}): {
  start(): Promise<void>;                 // 未終了レコードの finalize と prune、初回 listRecent
  onTick(entry: EstimationLogEntry): void;
  getRecent(): RideRecord[];              // 直近 maxRecords 件のキャッシュ（startedAtMs 降順）
  subscribe(listener: (rides: RideRecord[]) => void): () => void;
  removeRide(id: string): Promise<void>;
  clearAll(): Promise<void>;
  exportAll(): Promise<RideRecord[]>;
};
```

- `onTick` は `toRideTick` → `reduceRideTick` を同期で回し、effects を直列キュー（Promise チェーン）で store に流す。
  store の失敗は `onError(error, 'ride-history-persist')` に渡して握りつぶす（乗車判定は続ける）。
- `close` の後に `prune(now - retentionMs, maxRecords)` を実行し、`listRecent` でキャッシュを更新して購読者に通知する。
- `start()` で `findOpen()` の各レコードを `finalizeDanglingRecord` で閉じる（`null` なら `remove`）。

`main.ts` は `bootstrapApp` の後に `createRideHistoryController({ store: new IndexedDbRideHistoryStore(), onError: captureRuntimeError })`
を作り、`logger.subscribe((entry) => rideHistory.onTick(entry))` を既存の購読の隣に足す。`await rideHistory.start()` は
`controller.start()` の前に行う。IndexedDB を開けない環境では `InMemoryRideHistoryStore` にフォールバックする。

## 表示

`src/ui/ride-history-view.ts`（純関数）

```ts
export type RideListItem = {
  id: string;
  lineName: string;
  route: string;        // 「海老名 → 相模大野」。片方欠けは「海老名 →」「→ 相模大野」、両方欠けは「区間不明」
  direction: string;    // directionName ?? ''
  when: string;         // 「09/26 07:41」（formatLocalDateTime と同じ ja-JP 固定、年なし）
  duration: string;     // 「25分」「1時間05分」
  distance: string;     // 「12.3km」「620m」（route-candidates と同じ丸め）
};
export type RideDetailView = RideListItem & {
  startedAt: string;    // 「2026/09/26 07:41」
  endedAt: string;
  operatorName: string;
  maxSpeed: string;     // 「93 km/h」または「--」
  passedStations: string[];
  endReasonLabel: string; // transfer=乗換, route-lost=路線判定終了, stopped=停車, app-restart=アプリ再起動
};

export function buildHistoryCardView(rides: RideRecord[], count: number): { items: RideListItem[]; emptyText: string | null };
export function buildHistoryListView(rides: RideRecord[], expandedId: string | null): {
  items: Array<{ item: RideListItem; detail: RideDetailView | null }>;
  emptyText: string | null;
  exportDisabled: boolean;
  clearDisabled: boolean;
};
export function formatRideDuration(ms: number): string;
export function formatRideDistance(meters: number): string;
```

空状態の文言: 「乗車履歴はまだありません。路線が判定された状態で走行すると自動で記録されます」。

ホームのカード

- `#history-card-body` に `<ul class="history-list">` を描き、各 `<li>` は `<button type="button" data-ride-id>` で
  1 行目 `lineName`（太字）+ `direction`、2 行目 `route`、3 行目 `when · duration · distance`。
- 空なら `card-empty` クラスと `emptyText` に戻す。
- タップで `expandedId` をその乗車にして `#/history` へ移動する。

`#/history` ビュー

```
<h2>乗車履歴</h2>
<div class="history-actions">
  <button id="btn-history-export" class="btn btn-secondary">エクスポート</button>
  <button id="btn-history-clear" class="btn btn-danger">すべて削除</button>
</div>
<p id="history-export-status" class="history-export-status" hidden></p>
<div id="history-export-panel" hidden>
  <p>共有やコピーが使えないため、下のテキストを長押しして選択・コピーしてください。</p>
  <textarea id="history-export-text" readonly rows="8"></textarea>
</div>
<p id="history-empty" class="card-empty" hidden></p>
<ul id="history-list" class="history-list"></ul>
```

- 一覧の各 `<li>` はカードと同じ 3 行の `<button data-ride-id>`。タップで展開・折りたたみ（`expandedId` のトグル）。
- 展開部（`<div class="history-detail">`）は `startedAt`〜`endedAt`、`operatorName`、`maxSpeed`、`passedStations`
  を「・」区切りで、`endReasonLabel`、右下に「この乗車を削除」ボタン（`data-ride-delete`）。
- 「すべて削除」と「この乗車を削除」は `window.confirm` で確認する（既存の診断ログ削除と同じ）。
- 描画は `renderHistory(rides, expandedId)` として `main.ts` に置き、`replaceChildren` と `createElement` で組む
  （`innerHTML` を使わない）。ホームのカードと `#/history` は同じ `rides` から描く。

CSS（`src/index.css`）: `.history-list`（`list-style: none; padding: 0; margin: 10px 0 0`）、`.history-item`（区切り線、
`padding: 10px 0`）、`.history-item-button`（幅 100%、背景なし、左寄せ、色は本文色）、`.history-item-meta`（`#8b949e`、`font-size: 13px`）、
`.history-detail`（`margin-top: 8px`、`font-size: 14px`、`line-height: 1.6`）、`.history-actions`（`display: flex; gap: 8px; margin-top: 12px`）、
`#history-export-text`（幅 100%、等幅、`font-size: 12px`、`background: var(--panel-bg)`、`color` は本文色）。

## エクスポート

`src/ui/ride-export.ts`

```ts
export type RideHistoryExport = {
  format: 'railglance-ride-history';
  version: 1;
  exportedAt: string;        // ISO 8601
  appVersion: string;        // readBuildInfo().version 相当
  rides: Array<{
    id: string;
    line: { id: string; name: string; operator: string | null };
    direction: string | null;
    from: RideStationRef | null;
    to: RideStationRef | null;
    passedStations: RideStationRef[];
    startedAt: string;       // ISO 8601
    endedAt: string;
    durationSeconds: number;
    distanceMeters: number;  // 整数に丸める
    maxSpeedKmh: number | null;  // 小数 1 桁
    endReason: RideEndReason;
  }>;
};

export function buildRideHistoryExport(rides: RideRecord[], exportedAtMs: number, appVersion: string): RideHistoryExport;
export function serializeRideHistoryExport(payload: RideHistoryExport): string; // JSON.stringify(payload, null, 2)

export type ExportCapabilities = {
  share?: (text: string, title: string) => Promise<void>;   // navigator.share が関数のときだけ渡す
  copy?: (text: string) => Promise<void>;                   // navigator.clipboard.writeText が関数のときだけ渡す
};
export type ExportOutcome = 'shared' | 'copied' | 'manual' | 'cancelled';

export async function exportRideHistoryText(text: string, title: string, caps: ExportCapabilities): Promise<ExportOutcome>;
```

- `share` があれば呼ぶ。成功で `'shared'`。`AbortError`（ユーザが共有シートを閉じた）は `'cancelled'` として次に進まない。
  それ以外の失敗は `copy` に進む。
- `copy` があれば呼ぶ。成功で `'copied'`。失敗は `'manual'`。
- どちらも無ければ `'manual'`。
- `main.ts` は結果に応じて `#history-export-status` に「共有しました」「クリップボードにコピーしました」「共有もコピーも使えないため、
  下のテキストをコピーしてください」を出し、`'manual'` のときだけ `#history-export-panel` を表示して `textarea` に本文を入れる。
  `'cancelled'` は何も出さない。共有のタイトルは「RailGlance 乗車履歴」。乗車 0 件ならボタンは無効。
- `navigator.share` は `{ title, text }` で呼ぶ（ファイル添付はしない。WebView での `canShare({ files })` は未確認）。

## テレメトリとの関係

履歴は `TelemetrySink` に流さず、`RuntimeTelemetryManager` の状態も読まない。乗車の記録・削除はテレメトリイベントを出さない。
`docs/TELEMETRY_AND_SENTRY.md` に「乗車履歴は端末内のみ（`RailGlanceRideHistory`）で、診断収集の対象外」と 1 行追記する。

## 実装構成

| ファイル | 役割 |
| --- | --- |
| `src/domain/history/ride-record.ts` | `RideRecord` などの型 |
| `src/domain/history/ride-recorder.ts` | `toRideTick`、`reduceRideTick`、`finalizeDanglingRecord`、`createInitialRideRecorderState` |
| `src/config/ride-history-config.ts` | `RideHistoryConfig` と既定値 |
| `src/infrastructure/storage/ride-history-store.ts` | `RideHistoryStore`、`IndexedDbRideHistoryStore`、`InMemoryRideHistoryStore` |
| `src/app/ride-history-controller.ts` | reducer と store の調停、購読、起動時の finalize と prune |
| `src/ui/ride-history-view.ts` | カード・一覧・詳細のビューモデルと整形関数 |
| `src/ui/ride-export.ts` | エクスポート payload の構築、直列化、手段の順次試行 |
| `index.html` | `#/history` ビューの一覧・操作・エクスポート領域 |
| `src/index.css` | 履歴一覧・詳細・エクスポート領域のスタイル |
| `src/main.ts` | コントローラ生成、`logger.subscribe` の追加、ホームカードと一覧の描画、ボタン配線 |
| `README.md` | モジュール一覧に上記を追記 |
| `docs/TELEMETRY_AND_SENTRY.md` | 履歴が診断収集の対象外である旨を追記 |

## テスト

すべて Node 環境の Vitest。

- `tests/history/ride-recorder.test.ts`: 合成 tick 列で次を検証する。
  - 29 秒の committed では `riding` にならず、30 秒で record が作られ `persist` が出る。停止 tick だけでは昇格しない。
  - candidate 中に非 committed になれば `idle` に戻り record なし。
  - `previousStation` の変化で `passedStations` が伸び `persist` が出る。同じ駅の連続では伸びない。`fromStation` は最初の非 `null`。
  - 30 秒未満の間隔では `persist` が出ず、30 秒以上で出る。
  - 別路線への切替で `close(transfer)`、`endedAtMs` が旧路線の最後の tick、直後に新路線の candidate が始まる。
  - 180 秒の非 committed で `close(route-lost)`、`endedAtMs` が最後の committed tick。179 秒では閉じない。
  - 600 秒の停止で `close(stopped)`、`endedAtMs` が停止開始 tick。途中で動けばカウンタが消える。
  - 距離: 精度 100 m 超のサンプル除外、5 km 超の跳び除外、同一 `timestampMs` の重複除外、候補段階の距離が含まれる。
  - 最短未満（2 分未満、または 500 m 未満）は `discard` になる。
  - `maxSpeedKmh` の更新、`toStation` が最後の `previousStation`。
  - `finalizeDanglingRecord` が `app-restart` で閉じ、最短未満で `null`。
  - `toRideTick` が `EstimationLogEntry` の各 lockState / `line: null` を正しく `committed` に、`status` を `tracking` に写す。
  - `committed` だが `tracking` でない tick では candidate が始まらず、riding 中は継続する（トンネル内の `GPS_UNAVAILABLE`）。
- `tests/storage/ride-history-store.test.ts`: fake-indexeddb で `put` / `get` / `findOpen` / `listRecent`（closed のみ、降順、limit）/
  `listAll` / `remove` / `clear` / `prune`（期限、件数超過、open は残す）。`InMemoryRideHistoryStore` にも同じケースを流す。
- `tests/app/ride-history-controller.test.ts`: `InMemoryRideHistoryStore` と固定 `now` で、tick を流して store に open → closed が書かれること、
  `subscribe` が close 後に呼ばれること、`start()` が未終了レコードを閉じること（最短未満は削除）、store 失敗が `onError` に渡り
  処理が続くこと、`removeRide` / `clearAll` 後の通知。
- `tests/ui/ride-history-view.test.ts`: 空状態、`count` 件の切り出し、`route` の 4 パターン、`formatRideDuration`（59 秒、1 分、
  60 分、1 時間 5 分）、`formatRideDistance`（999 m / 1000 m 境界）、`expandedId` の展開、`endReasonLabel`、`exportDisabled` / `clearDisabled`。
- `tests/ui/ride-export.test.ts`: payload の形（ISO 時刻、`durationSeconds`、距離の整数丸め、`maxSpeedKmh` 小数 1 桁、降順）、
  `exportRideHistoryText` の 4 結果（share 成功、share `AbortError` → `cancelled`、share 失敗 → copy 成功、両方なし → manual、
  copy 失敗 → manual）。
- 手動確認（`pnpm dev` のシミュレーターと実機 Even App）: 小田急線デモで 2 分以上走らせて閉じた後に履歴が出ること
  （駅は「区間不明」）、リロード後も残ること、`#/history` の展開・削除・すべて削除、エクスポートで実機の WebView がどの手段に
  落ちるか（共有シート / コピー / テキスト表示）を記録して Issue に書くこと。

## スコープ外

- CSV など JSON 以外の形式。
- 乗車の手動追加・編集、乗車中のリアルタイム表示（ホームの現在の乗車カードは変更しない）。
- 履歴のクラウド同期・テレメトリ送信。
- 英語ローカライズ。
- `navigator.share` のファイル添付。
