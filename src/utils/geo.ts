/**
 * 地理座標工具（隱私優先：只用「時區」推近似區域，不碰 GPS/IP）。
 *
 * 時區 → 大致經緯度。這是刻意粗略的——只到「區域」等級，用於地球動畫的
 * 視覺定位，不精確、不收集、不外傳精確位置（見 ADR-0004 隱私定位）。
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * 常見 IANA 時區 → 代表城市的大致經緯度。
 * 未列入者以 timezone offset 推經度（緯度取 0）。
 */
const TZ_COORDS: Record<string, LatLng> = {
  'Asia/Taipei': { lat: 25.0, lng: 121.5 },
  'Asia/Tokyo': { lat: 35.7, lng: 139.7 },
  'Asia/Shanghai': { lat: 31.2, lng: 121.5 },
  'Asia/Hong_Kong': { lat: 22.3, lng: 114.2 },
  'Asia/Singapore': { lat: 1.35, lng: 103.8 },
  'Asia/Seoul': { lat: 37.6, lng: 127.0 },
  'Asia/Kolkata': { lat: 28.6, lng: 77.2 },
  'Asia/Bangkok': { lat: 13.75, lng: 100.5 },
  'Asia/Dubai': { lat: 25.2, lng: 55.3 },
  'Asia/Jakarta': { lat: -6.2, lng: 106.8 },
  'Europe/London': { lat: 51.5, lng: -0.13 },
  'Europe/Paris': { lat: 48.85, lng: 2.35 },
  'Europe/Berlin': { lat: 52.52, lng: 13.4 },
  'Europe/Madrid': { lat: 40.4, lng: -3.7 },
  'Europe/Rome': { lat: 41.9, lng: 12.5 },
  'Europe/Moscow': { lat: 55.75, lng: 37.6 },
  'Europe/Amsterdam': { lat: 52.37, lng: 4.9 },
  'Europe/Istanbul': { lat: 41.0, lng: 28.98 },
  'America/New_York': { lat: 40.7, lng: -74.0 },
  'America/Chicago': { lat: 41.85, lng: -87.65 },
  'America/Denver': { lat: 39.74, lng: -104.99 },
  'America/Los_Angeles': { lat: 34.05, lng: -118.24 },
  'America/Toronto': { lat: 43.65, lng: -79.38 },
  'America/Mexico_City': { lat: 19.43, lng: -99.13 },
  'America/Sao_Paulo': { lat: -23.55, lng: -46.63 },
  'America/Buenos_Aires': { lat: -34.6, lng: -58.38 },
  'Australia/Sydney': { lat: -33.87, lng: 151.2 },
  'Australia/Melbourne': { lat: -37.81, lng: 144.96 },
  'Australia/Perth': { lat: -31.95, lng: 115.86 },
  'Pacific/Auckland': { lat: -36.85, lng: 174.76 },
  'Africa/Cairo': { lat: 30.04, lng: 31.24 },
  'Africa/Johannesburg': { lat: -26.2, lng: 28.04 },
  'Africa/Lagos': { lat: 6.52, lng: 3.38 },
};

/** 讀取本機 IANA 時區（失敗回 UTC） */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 由時區推算近似經度（以當下該時區的 UTC offset 分鐘數換算）。 */
function longitudeFromOffset(timeZone: string): number {
  try {
    // 用 Intl 取得該時區相對 UTC 的偏移（分鐘），15°/小時 → 經度
    const now = new Date();
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    });
    const part = dtf.formatToParts(now).find((p) => p.type === 'timeZoneName');
    const m = part?.value.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
    if (m) {
      const hours = parseInt(m[1], 10);
      const mins = m[2] ? parseInt(m[2], 10) : 0;
      const totalHours = hours + Math.sign(hours) * (mins / 60);
      return Math.max(-180, Math.min(180, totalHours * 15));
    }
  } catch {
    // fall through
  }
  return 0;
}

/**
 * 時區 → 近似經緯度。對照表優先；否則用 offset 推經度、緯度取 0（赤道帶）。
 */
export function timezoneToLatLng(timeZone: string | undefined | null): LatLng {
  if (timeZone && TZ_COORDS[timeZone]) return TZ_COORDS[timeZone];
  return { lat: 0, lng: longitudeFromOffset(timeZone || 'UTC') };
}

/**
 * 正交投影（orthographic）：把經緯度投到以 (cx,cy) 為球心、半徑 r 的畫布上。
 * rotationDeg 為地球自轉角（繞極軸）。回傳畫布座標與是否位於可見半球（正面）。
 */
export function projectOrthographic(
  point: LatLng,
  cx: number,
  cy: number,
  r: number,
  rotationDeg: number
): { x: number; y: number; visible: boolean } {
  const latRad = (point.lat * Math.PI) / 180;
  const lngRad = ((point.lng + rotationDeg) * Math.PI) / 180;
  // 3D 球面座標（y 向上為北極）
  const x3 = Math.cos(latRad) * Math.sin(lngRad);
  const y3 = Math.sin(latRad);
  const z3 = Math.cos(latRad) * Math.cos(lngRad);
  return {
    x: cx + x3 * r,
    y: cy - y3 * r,
    visible: z3 >= 0, // z>=0 面向觀察者
  };
}
