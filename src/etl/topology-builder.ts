import { RailwayLine, RailwayRoute, Station, TrackSegment } from '../domain/models/railway';
import { haversineDistance } from '../domain/geo/distance';

export class TopologyBuilder {
  public buildTopology(
    lines: RailwayLine[],
    stations: Station[],
    segments: TrackSegment[]
  ): { lines: RailwayLine[]; routes: RailwayRoute[]; stations: Station[]; segments: TrackSegment[] } {
    const stationById = new Map(stations.map((station) => [station.id, station]));
    const processedStations = [...stations].sort(
      (a, b) => a.lineId.localeCompare(b.lineId) || a.sequence - b.sequence || a.id.localeCompare(b.id)
    );
    const segmentsByLine = new Map<string, TrackSegment[]>();

    for (const segment of segments) {
      const from = stationById.get(segment.fromStationId);
      const to = stationById.get(segment.toStationId);
      if (!from || !to || from.lineId !== segment.lineId || to.lineId !== segment.lineId) {
        throw new Error(`Segment ${segment.id} references missing or cross-line stations`);
      }
      if (segment.coordinates.length < 2) {
        throw new Error(`Segment ${segment.id} must contain at least two coordinates`);
      }
      const list = segmentsByLine.get(segment.lineId) ?? [];
      list.push({ ...segment });
      segmentsByLine.set(segment.lineId, list);
    }

    const processedSegments: TrackSegment[] = [];
    const generatedRoutes: RailwayRoute[] = [];

    for (const [lineId, lineSegments] of [...segmentsByLine].sort(([a], [b]) => a.localeCompare(b))) {
      const incident = new Map<string, TrackSegment[]>();
      for (const segment of lineSegments) {
        incident.set(segment.fromStationId, [...(incident.get(segment.fromStationId) ?? []), segment]);
        incident.set(segment.toStationId, [...(incident.get(segment.toStationId) ?? []), segment]);
      }
      for (const [stationId, stationSegments] of incident) {
        if (new Set(stationSegments.map((segment) => segment.id)).size > 2) {
          throw new Error(
            `Line ${lineId} branches at station ${stationId}; split branches into explicit routes before publishing`
          );
        }
      }

      const remaining = new Map(lineSegments.map((segment) => [segment.id, segment]));
      const paths: TrackSegment[][] = [];
      while (remaining.size > 0) {
        const remainingSegments = [...remaining.values()];
        const remainingIncidentCount = (stationId: string) =>
          (incident.get(stationId) ?? []).filter((segment) => remaining.has(segment.id)).length;
        const endpointIds = [...new Set(remainingSegments.flatMap(
          (segment) => [segment.fromStationId, segment.toStationId]
        ))].filter((stationId) => remainingIncidentCount(stationId) === 1);
        const startStationId = (endpointIds.length > 0 ? endpointIds : [
          ...new Set(remainingSegments.flatMap((segment) => [segment.fromStationId, segment.toStationId])),
        ]).sort((a, b) => this.compareStations(a, b, stationById))[0];

        const path: TrackSegment[] = [];
        let currentStationId = startStationId;
        while (currentStationId) {
          const next = (incident.get(currentStationId) ?? [])
            .filter((segment) => remaining.has(segment.id))
            .sort((a, b) => a.id.localeCompare(b.id))[0];
          if (!next) break;
          remaining.delete(next.id);
          const oriented = next.fromStationId === currentStationId
            ? { ...next }
            : {
                ...next,
                fromStationId: next.toStationId,
                toStationId: next.fromStationId,
                coordinates: [...next.coordinates].reverse() as Array<[number, number]>,
              };
          path.push(oriented);
          currentStationId = oriented.toStationId;
        }
        paths.push(path);
      }

      paths.forEach((path, pathIndex) => {
        const routeId = paths.length === 1 ? `route-${lineId}-main` : `route-${lineId}-${pathIndex + 1}`;
        const isRing = path.length > 1 && path[path.length - 1].toStationId === path[0].fromStationId;
        let cumulativeMeters = 0;
        const routeSegments = path.map((segment, index): TrackSegment => {
          const lengthMeters = segment.lengthMeters ?? this.calculateLength(segment);
          const previous = index > 0 ? path[index - 1] : isRing ? path[path.length - 1] : undefined;
          const next = index < path.length - 1 ? path[index + 1] : isRing ? path[0] : undefined;
          const processed = {
            ...segment,
            routeId,
            lengthMeters,
            startOffsetMeters: cumulativeMeters,
            cumulativeDistanceMeters: cumulativeMeters + lengthMeters,
            previousSegmentIds: previous ? [previous.id] : [],
            nextSegmentIds: next ? [next.id] : [],
          };
          cumulativeMeters += lengthMeters;
          return processed;
        });
        processedSegments.push(...routeSegments);
        generatedRoutes.push({
          id: routeId,
          lineId,
          direction: 'UP',
          stationIds: routeSegments.length === 0
            ? []
            : [routeSegments[0].fromStationId, ...routeSegments.map((segment) => segment.toStationId)],
          segmentIds: routeSegments.map((segment) => segment.id),
          totalLengthMeters: cumulativeMeters,
        });
      });
    }

    return { lines, routes: generatedRoutes, stations: processedStations, segments: processedSegments };
  }

  private compareStations(a: string, b: string, stationById: Map<string, Station>): number {
    return (stationById.get(a)?.sequence ?? 0) - (stationById.get(b)?.sequence ?? 0) || a.localeCompare(b);
  }

  private calculateLength(segment: TrackSegment): number {
    let meters = 0;
    for (let index = 0; index < segment.coordinates.length - 1; index++) {
      const [startLat, startLon] = segment.coordinates[index];
      const [endLat, endLon] = segment.coordinates[index + 1];
      meters += haversineDistance(startLat, startLon, endLat, endLon);
    }
    return Math.round(meters);
  }
}
