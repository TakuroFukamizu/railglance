import { DataProvenance } from './provenance';

export type RailwayLine = {
  id: string;
  operatorId: string;
  operatorName?: string;
  name: string;
  shortName?: string;
  directionAName?: string;
  directionBName?: string;
  provenance?: DataProvenance[];
};

export type RailwayRoute = {
  id: string;
  lineId: string;
  direction: TravelDirection;
  stationIds: string[];
  segmentIds: string[];
  totalLengthMeters: number;
  provenance?: DataProvenance[];
};

export type Station = {
  id: string;
  lineId: string;
  name: string;
  sequence: number;
  latitude: number;
  longitude: number;
  routeOffsetMeters?: number;
  provenance?: DataProvenance[];
};

export type TrackSegment = {
  id: string;
  lineId: string;
  routeId?: string;
  fromStationId: string;
  toStationId: string;
  coordinates: Array<[number, number]>; // [latitude, longitude]
  lengthMeters?: number;
  startOffsetMeters?: number;
  cumulativeDistanceMeters?: number;
  previousSegmentIds?: string[];
  nextSegmentIds?: string[];
  provenance?: DataProvenance[];
};

export type DatasetMetadata = {
  version: string;
  schemaVersion: string;
  generatedAt: string;
  area: string;
  licensing?: {
    sources: Array<{
      sourceId: string;
      attributionText: string;
      licenseId: string;
    }>;
  };
};

export type TravelDirection = 'UP' | 'DOWN' | 'DIRECTION_A' | 'DIRECTION_B' | 'UNKNOWN';

export type RouteCandidateScore = {
  segment: TrackSegment;
  line: RailwayLine;
  distanceMeters: number;
  distanceScore: number;
  headingScore: number;
  continuityScore: number;
  historyScore: number;
  totalScore: number;
  projectedPoint: [number, number]; // [latitude, longitude]
  bearingDegrees: number;
};

export type RouteMatch = {
  selectedLine: RailwayLine;
  selectedSegment: TrackSegment;
  confidence: number; // 0.0 to 1.0
  candidates: RouteCandidateScore[];
  timestampMs: number;
};

export type JourneyState = {
  line: RailwayLine | null;
  direction: TravelDirection;
  directionName: string | null;
  previousStation: Station | null;
  nextStation: Station | null;
  distanceToNextStationMeters: number | null;
  progressRatio: number | null; // 0.0 to 1.0
  confidence: number;
  status: 'INITIALIZING' | 'WAITING_FOR_GPS' | 'MATCHING_ROUTE' | 'TRACKING' | 'GPS_UNAVAILABLE' | 'ROUTE_UNCERTAIN' | 'GPS_LOW_ACCURACY';
};
