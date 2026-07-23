export type RailwayLine = {
  id: string;
  operatorId: string;
  name: string;
  shortName?: string;
  directionAName?: string;
  directionBName?: string;
};

export type Station = {
  id: string;
  lineId: string;
  name: string;
  sequence: number;
  latitude: number;
  longitude: number;
};

export type TrackSegment = {
  id: string;
  lineId: string;
  fromStationId: string;
  toStationId: string;
  coordinates: Array<[number, number]>; // [longitude, latitude] or [latitude, longitude]? Standard in GeoJSON is [lng, lat], but let's support [lat, lng] or tuple. We'll use [latitude, longitude].
  lengthMeters?: number;
};

export type DatasetMetadata = {
  version: string;
  generatedAt: string;
  area: string;
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
  confidence: number;
  status: 'INITIALIZING' | 'WAITING_FOR_GPS' | 'MATCHING_ROUTE' | 'TRACKING' | 'GPS_UNAVAILABLE' | 'ROUTE_UNCERTAIN';
};
