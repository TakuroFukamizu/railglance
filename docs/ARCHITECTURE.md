# アーキテクチャ

## 基本方針

Even G2側は表示専用とし、計算はスマートフォン側で行います。

```text
Smartphone
  ├─ GPS取得
  ├─ 速度計算
  ├─ 路線推定
  ├─ 駅推定
  ├─ ローカルDB
  └─ HUD生成
        ↓
      Even G2
```

## コンポーネント

### LocationProvider

```ts
interface LocationProvider {
  start(onLocation: (sample: LocationSample) => void): Promise<void>;
  stop(): Promise<void>;
}
```

### SpeedEstimator

```ts
interface SpeedEstimator {
  update(sample: LocationSample): SpeedEstimate;
  reset(): void;
}
```

### RailwayDatabase

```ts
interface RailwayDatabase {
  initialize(): Promise<void>;
  findSegmentsNear(
    latitude: number,
    longitude: number,
    radiusMeters: number
  ): Promise<TrackSegment[]>;
  getLine(lineId: string): Promise<RailwayLine | undefined>;
  getStationsByLine(lineId: string): Promise<Station[]>;
}
```

### MapMatcher

```ts
interface MapMatcher {
  match(
    sample: LocationSample,
    history: LocationSample[],
    previousState?: RouteMatch
  ): Promise<RouteMatchResult>;
}
```

### JourneyStateEstimator

```ts
interface JourneyStateEstimator {
  update(match: RouteMatch, speed: SpeedEstimate): JourneyState;
}
```

### HudRenderer

```ts
interface HudRenderer {
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
}
```

## 将来拡張インターフェース

Phase 2:

```ts
interface TimetableRepository {
  findTrips(query: TimetableQuery): Promise<TrainTrip[]>;
}

interface TrainCandidateEstimator {
  update(observation: TrainObservation): TrainCandidateResult;
}
```

Phase 3:

```ts
interface RealtimeTransitRepository {
  getRealtimeState(query: RealtimeTransitQuery): Promise<RealtimeTransitState>;
}
```

Phase 1では型定義または空実装のみとします。

## ストレージ

```text
Bundled JSON
    ↓ 初回インポート
IndexedDB / Dexie
```

## セキュリティ

Phase 1ではネットワーク通信を行わないためAPIキーはありません。Phase 3では事業者APIをクライアントから直接呼ばず、自前バックエンド経由とします。
