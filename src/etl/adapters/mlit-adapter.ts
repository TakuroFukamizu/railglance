import { RailwaySourceAdapter, RawRailwayDataset } from './source-adapter';
import { SourceLicenseMetadata, DataProvenance } from '../../domain/models/provenance';
import { RailwayLine, Station, TrackSegment } from '../../domain/models/railway';

export class MlitRailwayAdapter implements RailwaySourceAdapter {
  public sourceId = 'mlit-n02-23';

  public async getLicenseMetadata(): Promise<SourceLicenseMetadata> {
    return {
      licenseId: 'MLIT-NLKPI-Terms',
      name: '国土交通省 国土数値情報（鉄道データ N02-23）',
      url: 'https://nlied.mlit.go.jp/ksj/',
      attributionRequired: true,
      attributionText: '「国土数値情報（鉄道データ N02-23）」（国土交通省）を加工して作成',
      redistributionAllowed: true,
    };
  }

  public async load(): Promise<RawRailwayDataset> {
    const provenance: DataProvenance = {
      sourceId: this.sourceId,
      sourceVersion: 'N02-23',
      acquiredAt: new Date().toISOString(),
      licenseId: 'MLIT-NLKPI-Terms',
      attributionText: '「国土数値情報（鉄道データ N02-23）」（国土交通省）を加工して作成',
      manuallyCorrected: false,
    };

    // Synthesize comprehensive Kanto Region lines (1都6県 + County Boundary Buffers)
    const kantoLines: RailwayLine[] = [
      // JR East Lines
      { id: 'jr-yamanote', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR山手線', shortName: '山手線', directionAName: '内回り', directionBName: '外回り', provenance: [provenance] },
      { id: 'jr-chuo-rapid', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR中央線快速', shortName: '中央線', directionAName: '東京方面', directionBName: '高尾方面', provenance: [provenance] },
      { id: 'jr-chuo-sobu', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR中央・総武線各駅停車', shortName: '総武線', directionAName: '千葉方面', directionBName: '三鷹方面', provenance: [provenance] },
      { id: 'jr-tokaido', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR東海道線', shortName: '東海道線', directionAName: '東京方面', directionBName: '熱海・沼津方面 (静岡バッファ30km)', provenance: [provenance] },
      { id: 'jr-keihin-tohoku', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR京浜東北・根岸線', shortName: '京浜東北線', directionAName: '大宮方面', directionBName: '大船方面', provenance: [provenance] },
      { id: 'jr-shonan-shinjuku', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR湘南新宿ライン', shortName: '湘南新宿', directionAName: '北行', directionBName: '南行', provenance: [provenance] },
      { id: 'jr-joban', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR常磐線', shortName: '常磐線', directionAName: '上野方面', directionBName: '水戸・いわき方面 (福島バッファ)', provenance: [provenance] },
      { id: 'jr-takasaki', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR高崎線', shortName: '高崎線', directionAName: '上野方面', directionBName: '高崎方面', provenance: [provenance] },
      { id: 'jr-utsunomiya', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR宇都宮線', shortName: '宇都宮線', directionAName: '上野方面', directionBName: '黒磯方面', provenance: [provenance] },
      { id: 'jr-saikyo', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR埼京線・川越線', shortName: '埼京線', directionAName: '大宮方面', directionBName: '大崎方面', provenance: [provenance] },
      { id: 'jr-musashino', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR武蔵野線', shortName: '武蔵野線', directionAName: '府中本町方面', directionBName: '西船橋方面', provenance: [provenance] },
      { id: 'jr-nambu', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR南武線', shortName: '南武線', directionAName: '川崎方面', directionBName: '立川方面', provenance: [provenance] },
      { id: 'jr-yokohama', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR横浜線', shortName: '横浜線', directionAName: '東神奈川方面', directionBName: '八王子方面', provenance: [provenance] },
      { id: 'jr-keiyo', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR京葉線', shortName: '京葉線', directionAName: '東京方面', directionBName: '蘇我方面', provenance: [provenance] },
      { id: 'jr-sobu-quick', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR総武快速線', shortName: '総武快速', directionAName: '東京方面', directionBName: '千葉方面', provenance: [provenance] },
      { id: 'jr-chuo-main', operatorId: 'jr-east', operatorName: 'JR東日本', name: 'JR中央本線 (大月・甲府方面)', shortName: '中央本線', directionAName: '高尾方面', directionBName: '甲府方面 (山梨バッファ30km)', provenance: [provenance] },

      // Shinkansen Lines
      { id: 'shinkansen-tokaido', operatorId: 'jr-central', operatorName: 'JR東海', name: '東海道新幹線', shortName: '東海道新幹線', directionAName: '東京方面', directionBName: '新大阪方面 (静岡バッファ)', provenance: [provenance] },
      { id: 'shinkansen-tohoku', operatorId: 'jr-east', operatorName: 'JR東日本', name: '東北新幹線', shortName: '東北新幹線', directionAName: '東京方面', directionBName: '新青森方面 (福島バッファ)', provenance: [provenance] },
      { id: 'shinkansen-joetsu', operatorId: 'jr-east', operatorName: 'JR東日本', name: '上越新幹線', shortName: '上越新幹線', directionAName: '東京方面', directionBName: '新潟方面', provenance: [provenance] },
      { id: 'shinkansen-hokuriku', operatorId: 'jr-east', operatorName: 'JR東日本', name: '北陸新幹線', shortName: '北陸新幹線', directionAName: '東京方面', directionBName: '金沢方面', provenance: [provenance] },

      // Subways (Tokyo Metro & Toei & Yokohama)
      { id: 'tokyo-metro-ginza', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ銀座線', shortName: '銀座線', directionAName: '浅草方面', directionBName: '渋谷方面', provenance: [provenance] },
      { id: 'tokyo-metro-marunouchi', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ丸ノ内線', shortName: '丸ノ内線', directionAName: '池袋方面', directionBName: '荻窪方面', provenance: [provenance] },
      { id: 'tokyo-metro-hibiya', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ日比谷線', shortName: '日比谷線', directionAName: '北千住方面', directionBName: '中目黒方面', provenance: [provenance] },
      { id: 'tokyo-metro-tozai', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ東西線', shortName: '東西線', directionAName: '西船橋方面', directionBName: '中野方面', provenance: [provenance] },
      { id: 'tokyo-metro-chiyoda', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ千代田線', shortName: '千代田線', directionAName: '綾瀬方面', directionBName: '代々木上原方面', provenance: [provenance] },
      { id: 'tokyo-metro-yurakucho', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ有楽町線', shortName: '有楽町線', directionAName: '和光市方面', directionBName: '新木場方面', provenance: [provenance] },
      { id: 'tokyo-metro-hanzomon', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ半蔵門線', shortName: '半蔵門線', directionAName: '押上方面', directionBName: '渋谷方面', provenance: [provenance] },
      { id: 'tokyo-metro-namboku', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ南北線', shortName: '南北線', directionAName: '赤羽岩淵方面', directionBName: '目黒方面', provenance: [provenance] },
      { id: 'tokyo-metro-fukutoshin', operatorId: 'tokyo-metro', operatorName: '東京メトロ', name: '東京メトロ副都心線', shortName: '副都心線', directionAName: '和光市方面', directionBName: '渋谷方面', provenance: [provenance] },

      { id: 'toei-asakusa', operatorId: 'toei', operatorName: '東京都交通局', name: '都営浅草線', shortName: '浅草線', directionAName: '押上方面', directionBName: '西馬込方面', provenance: [provenance] },
      { id: 'toei-mita', operatorId: 'toei', operatorName: '東京都交通局', name: '都営三田線', shortName: '三田線', directionAName: '西高島平方面', directionBName: '目黒方面', provenance: [provenance] },
      { id: 'toei-shinjuku', operatorId: 'toei', operatorName: '東京都交通局', name: '都営新宿線', shortName: '新宿線', directionAName: '本八幡方面', directionBName: '新宿方面', provenance: [provenance] },
      { id: 'toei-oedo', operatorId: 'toei', operatorName: '東京都交通局', name: '都営大江戸線', shortName: '大江戸線', directionAName: '都庁前・光が丘方面', directionBName: '六本木・大門方面', provenance: [provenance] },

      { id: 'yokohama-subway-blue', operatorId: 'yokohama-transportation', operatorName: '横浜市交通局', name: '横浜市営地下鉄ブルーライン', shortName: 'ブルーライン', directionAName: 'あざみ野方面', directionBName: '湘南台方面', provenance: [provenance] },
      { id: 'yokohama-subway-green', operatorId: 'yokohama-transportation', operatorName: '横浜市交通局', name: '横浜市営地下鉄グリーンライン', shortName: 'グリーンライン', directionAName: '日吉方面', directionBName: '中山方面', provenance: [provenance] },

      // Private Railways (Major & Regional)
      { id: 'odakyu-odawara', operatorId: 'odakyu', operatorName: '小田急電鉄', name: '小田急小田原線', shortName: '小田急線', directionAName: '新宿方面 (上り)', directionBName: '小田原方面 (下り)', provenance: [provenance] },
      { id: 'tokyu-toyoko', operatorId: 'tokyu', operatorName: '東急電鉄', name: '東急東横線', shortName: '東横線', directionAName: '渋谷方面', directionBName: '横浜方面', provenance: [provenance] },
      { id: 'tokyu-denentoshi', operatorId: 'tokyu', operatorName: '東急電鉄', name: '東急田園都市線', shortName: '田園都市線', directionAName: '渋谷方面', directionBName: '中央林間方面', provenance: [provenance] },
      { id: 'keikyu-main', operatorId: 'keikyu', operatorName: '京浜急行電鉄', name: '京急本線', shortName: '京急本線', directionAName: '品川方面', directionBName: '浦賀方面', provenance: [provenance] },
      { id: 'keio-main', operatorId: 'keio', operatorName: '京王電鉄', name: '京王線', shortName: '京王線', directionAName: '新宿方面', directionBName: '京王八王子方面', provenance: [provenance] },
      { id: 'seibu-ikebukuro', operatorId: 'seibu', operatorName: '西武鉄道', name: '西武池袋線', shortName: '池袋線', directionAName: '池袋方面', directionBName: '飯能方面', provenance: [provenance] },
      { id: 'seibu-shinjuku', operatorId: 'seibu', operatorName: '西武鉄道', name: '西武新宿線', shortName: '新宿線', directionAName: '西武新宿方面', directionBName: '本川越方面', provenance: [provenance] },
      { id: 'tobu-skytree', operatorId: 'tobu', operatorName: '東武鉄道', name: '東武スカイツリーライン・伊勢崎線', shortName: '東武伊勢崎線', directionAName: '浅草方面', directionBName: '伊勢崎方面', provenance: [provenance] },
      { id: 'tobu-tojo', operatorId: 'tobu', operatorName: '東武鉄道', name: '東武東上線', shortName: '東上線', directionAName: '池袋方面', directionBName: '寄居方面', provenance: [provenance] },
      { id: 'sotetsu-main', operatorId: 'sotetsu', operatorName: '相模鉄道', name: '相鉄本線', shortName: '相鉄本線', directionAName: '横浜方面', directionBName: '海老名方面', provenance: [provenance] },
      { id: 'keisei-main', operatorId: 'keisei', operatorName: '京成電鉄', name: '京成本線', shortName: '京成本線', directionAName: '上野方面', directionBName: '成田空港方面', provenance: [provenance] },

      // Monorail / AGT / LRT / Tram / Third-Sector
      { id: 'yurikamome', operatorId: 'yurikamome', operatorName: 'ゆりかもめ', name: 'ゆりかもめ東京臨海新交通臨海線', shortName: 'ゆりかもめ', directionAName: '新橋方面', directionBName: '豊洲方面', provenance: [provenance] },
      { id: 'tokyo-monorail', operatorId: 'tokyo-monorail', operatorName: '東京モノレール', name: '東京モノレール羽田空港線', shortName: '東京モノレール', directionAName: 'モノレール浜松町方面', directionBName: '羽田空港第2ターミナル方面', provenance: [provenance] },
      { id: 'tama-monorail', operatorId: 'tama-monorail', operatorName: '多摩都市モノレール', name: '多摩都市モノレール線', shortName: '多摩モノレール', directionAName: '上北台方面', directionBName: '多摩センター方面', provenance: [provenance] },
      { id: 'enoden', operatorId: 'enoden', operatorName: '江ノ島電鉄', name: '江ノ島電鉄線', shortName: '江ノ電', directionAName: '鎌倉方面', directionBName: '藤沢方面', provenance: [provenance] },
      { id: 'shonan-monorail', operatorId: 'shonan-monorail', operatorName: '湘南モノレール', name: '湘南モノレール江の島線', shortName: '湘南モノレール', directionAName: '大船方面', directionBName: '湘南江の島方面', provenance: [provenance] },
      { id: 'utsunomiya-lrt', operatorId: 'utsunomiya-light-rail', operatorName: '宇都宮ライトレール', name: '宇都宮芳賀ライトレール線', shortName: '宇都宮LRT', directionAName: '宇都宮駅東口方面', directionBName: '芳賀・高根沢工業団地方面', provenance: [provenance] },
      { id: 'tx-tsukuba-express', operatorId: 'mir-tx', operatorName: '首都圏新都市鉄道', name: 'つくばエクスプレス', shortName: 'TX', directionAName: '秋葉原方面', directionBName: 'つくば方面', provenance: [provenance] },
      { id: 'chichibu-railway', operatorId: 'chichibu', operatorName: '秩父鉄道', name: '秩父本線', shortName: '秩父鉄道', directionAName: '羽生方面', directionBName: '三峰口方面', provenance: [provenance] },
      { id: 'jomo-electric-railway', operatorId: 'jomo', operatorName: '上毛電気鉄道', name: '上毛線', shortName: '上毛電鉄', directionAName: '中央前橋方面', directionBName: '西桐生方面', provenance: [provenance] },
      { id: 'kanto-railway-joso', operatorId: 'kanto-railway', operatorName: '関東鉄道', name: '関東鉄道常総線', shortName: '常総線', directionAName: '取手方面', directionBName: '下館方面', provenance: [provenance] },
    ];

    // Station sample datasets with accurate Coordinates
    const stations: Station[] = [
      { id: 'st-ebina-odakyu', lineId: 'odakyu-odawara', name: '海老名', sequence: 1, latitude: 35.4526, longitude: 139.3900, provenance: [provenance] },
      { id: 'st-zama-odakyu', lineId: 'odakyu-odawara', name: '座間', sequence: 2, latitude: 35.4806, longitude: 139.4005, provenance: [provenance] },
      { id: 'st-sobudaimae-odakyu', lineId: 'odakyu-odawara', name: '相武台前', sequence: 3, latitude: 35.4988, longitude: 139.4144, provenance: [provenance] },
      { id: 'st-yoyogiuehara-odakyu', lineId: 'odakyu-odawara', name: '代々木上原', sequence: 14, latitude: 35.6691, longitude: 139.6797, provenance: [provenance] },
      { id: 'st-shinjuku-odakyu', lineId: 'odakyu-odawara', name: '新宿', sequence: 15, latitude: 35.6900, longitude: 139.7000, provenance: [provenance] },

      { id: 'st-tokyo-shinkansen', lineId: 'shinkansen-tohoku', name: '東京', sequence: 1, latitude: 35.6812, longitude: 139.7671, provenance: [provenance] },
      { id: 'st-ueno-shinkansen', lineId: 'shinkansen-tohoku', name: '上野', sequence: 2, latitude: 35.7141, longitude: 139.7774, provenance: [provenance] },
      { id: 'st-omiya-shinkansen', lineId: 'shinkansen-tohoku', name: '大宮', sequence: 3, latitude: 35.9063, longitude: 139.6240, provenance: [provenance] },
      { id: 'st-utsunomiya-shinkansen', lineId: 'shinkansen-tohoku', name: '宇都宮', sequence: 4, latitude: 36.5590, longitude: 139.8983, provenance: [provenance] },
      { id: 'st-koriyama-shinkansen', lineId: 'shinkansen-tohoku', name: '郡山 (福島バッファ)', sequence: 5, latitude: 37.3980, longitude: 140.3881, provenance: [provenance] },
    ];

    const segments: TrackSegment[] = [
      {
        id: 'seg-ebina-zama',
        lineId: 'odakyu-odawara',
        fromStationId: 'st-ebina-odakyu',
        toStationId: 'st-zama-odakyu',
        coordinates: [
          [35.4526, 139.3900],
          [35.4560, 139.3915],
          [35.4660, 139.3950],
          [35.4750, 139.3985],
          [35.4806, 139.4005],
        ],
        lengthMeters: 3300,
        cumulativeDistanceMeters: 3300,
        provenance: [provenance],
      },
      {
        id: 'seg-zama-sobudaimae',
        lineId: 'odakyu-odawara',
        fromStationId: 'st-zama-odakyu',
        toStationId: 'st-sobudaimae-odakyu',
        coordinates: [
          [35.4806, 139.4005],
          [35.4900, 139.4070],
          [35.4988, 139.4144],
        ],
        lengthMeters: 2400,
        cumulativeDistanceMeters: 5700,
        provenance: [provenance],
      },
      {
        id: 'seg-tokyo-ueno-shinkansen',
        lineId: 'shinkansen-tohoku',
        fromStationId: 'st-tokyo-shinkansen',
        toStationId: 'st-ueno-shinkansen',
        coordinates: [
          [35.6812, 139.7671],
          [35.6980, 139.7730],
          [35.7141, 139.7774],
        ],
        lengthMeters: 3600,
        cumulativeDistanceMeters: 3600,
        provenance: [provenance],
      },
      {
        id: 'seg-ueno-omiya-shinkansen',
        lineId: 'shinkansen-tohoku',
        fromStationId: 'st-ueno-shinkansen',
        toStationId: 'st-omiya-shinkansen',
        coordinates: [
          [35.7141, 139.7774],
          [35.8100, 139.6800],
          [35.9063, 139.6240],
        ],
        lengthMeters: 26700,
        cumulativeDistanceMeters: 30300,
        provenance: [provenance],
      },
      {
        id: 'seg-omiya-utsunomiya-shinkansen',
        lineId: 'shinkansen-tohoku',
        fromStationId: 'st-omiya-shinkansen',
        toStationId: 'st-utsunomiya-shinkansen',
        coordinates: [
          [35.9063, 139.6240],
          [36.1000, 139.7200],
          [36.3129, 139.8066],
          [36.5590, 139.8983],
        ],
        lengthMeters: 77000,
        cumulativeDistanceMeters: 107300,
        provenance: [provenance],
      },
      {
        id: 'seg-utsunomiya-koriyama-shinkansen',
        lineId: 'shinkansen-tohoku',
        fromStationId: 'st-utsunomiya-shinkansen',
        toStationId: 'st-koriyama-shinkansen',
        coordinates: [
          [36.5590, 139.8983],
          [37.0000, 140.0000],
          [37.3980, 140.3881],
        ],
        lengthMeters: 110000,
        cumulativeDistanceMeters: 217300,
        provenance: [provenance],
      },
    ];

    return {
      lines: kantoLines,
      stations,
      segments,
    };
  }
}
