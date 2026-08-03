import { RailwayLine, Station, TrackSegment } from '../domain/models/railway';
import { haversineDistance } from '../domain/geo/distance';

export class TopologyBuilder {
  public buildTopology(
    lines: RailwayLine[],
    stations: Station[],
    segments: TrackSegment[]
  ): { lines: RailwayLine[]; stations: Station[]; segments: TrackSegment[] } {
    // 1. Sort stations by sequence per line
    const stationsByLine = new Map<string, Station[]>();
    for (const st of stations) {
      if (!stationsByLine.has(st.lineId)) {
        stationsByLine.set(st.lineId, []);
      }
      stationsByLine.get(st.lineId)!.push(st);
    }

    const processedStations: Station[] = [];
    for (const list of stationsByLine.values()) {
      list.sort((a, b) => a.sequence - b.sequence);
      processedStations.push(...list);
    }

    // 2. Calculate segment lengths and cumulative distances
    const segmentsByLine = new Map<string, TrackSegment[]>();
    for (const seg of segments) {
      if (!segmentsByLine.has(seg.lineId)) {
        segmentsByLine.set(seg.lineId, []);
      }
      segmentsByLine.get(seg.lineId)!.push(seg);
    }

    const processedSegments: TrackSegment[] = [];

    for (const list of segmentsByLine.values()) {
      let cumulativeMeters = 0;

      for (const seg of list) {
        let segLen = 0;
        for (let i = 0; i < seg.coordinates.length - 1; i++) {
          const p1 = seg.coordinates[i];
          const p2 = seg.coordinates[i + 1];
          segLen += haversineDistance(p1[0], p1[1], p2[0], p2[1]);
        }

        const calculatedLength = seg.lengthMeters ?? Math.round(segLen);
        cumulativeMeters += calculatedLength;

        processedSegments.push({
          ...seg,
          lengthMeters: calculatedLength,
          cumulativeDistanceMeters: cumulativeMeters,
        });
      }
    }

    return {
      lines,
      stations: processedStations.length > 0 ? processedStations : stations,
      segments: processedSegments.length > 0 ? processedSegments : segments,
    };
  }
}
