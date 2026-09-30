/**
 * Zone distances are consistent, so fares are consistent (see the rule at the top of the distance table in
 * utils/fareCalculator.ts):
 *   1. triangle inequality: going through a zone is never shorter than the direct road;
 *   2. corridors are exactly additive: for zones on one road, A → B → C is exactly A → C.
 * Example: Gulshan → Mohakhali → Dhanmondi is 3 + 7 = 10 km, the same as Gulshan → Dhanmondi direct.
 */
import { DHAKA_ZONES } from '../models/RideRequest';
import {
  ROAD_CORRIDORS,
  buildZoneKm,
  calculateBaseFare,
  isOnRoute,
  segmentDistanceKm,
  segmentFare,
} from '../utils/fareCalculator';

const km = (a: string, b: string) => segmentDistanceKm(a, b);
const zones = [...DHAKA_ZONES] as string[];

describe('the distance table', () => {
  it('has a whole-number distance of at least 1 km between every two different zones, the same both ways', () => {
    for (const a of zones) {
      for (const b of zones) {
        if (a === b) { expect(km(a, b)).toBe(0); continue; }
        expect(Number.isInteger(km(a, b))).toBe(true);
        expect(km(a, b)).toBeGreaterThanOrEqual(1);
        expect(km(a, b)).toBe(km(b, a));
      }
    }
  });

  it('obeys the triangle inequality for every three zones: a detour is never shorter than the direct road', () => {
    let checked = 0;
    for (const a of zones) for (const b of zones) for (const c of zones) {
      expect(km(a, b) + km(b, c)).toBeGreaterThanOrEqual(km(a, c));
      checked++;
    }
    expect(checked).toBe(zones.length ** 3);
  });

  it('is exactly additive along every road corridor, for every ordered triple on it', () => {
    for (const corridor of ROAD_CORRIDORS) {
      expect(corridor.length).toBeGreaterThanOrEqual(3);
      for (const z of corridor) expect(zones).toContain(z);
      for (let i = 0; i < corridor.length; i++) for (let j = i + 1; j < corridor.length; j++) for (let k = j + 1; k < corridor.length; k++) {
        const [a, b, c] = [corridor[i]!, corridor[j]!, corridor[k]!];
        expect(km(a, b) + km(b, c)).toBe(km(a, c));
        expect(isOnRoute(a, b, c)).toBe(true);
      }
    }
  });

  it('the example: Gulshan → Mohakhali → Dhanmondi is 3 + 7 = 10 km, the same as Gulshan → Dhanmondi', () => {
    expect(km('Gulshan', 'Mohakhali')).toBe(3);
    expect(km('Mohakhali', 'Dhanmondi')).toBe(7);
    expect(km('Gulshan', 'Dhanmondi')).toBe(10);
    expect(isOnRoute('Gulshan', 'Mohakhali', 'Dhanmondi')).toBe(true);
    // and the trip cost agrees: ৳100 + 10 × ৳20 = ৳300 whichever way it is added up
    expect(calculateBaseFare('Gulshan', 'Dhanmondi', 1)).toBe(300);
  });

  it('a zone that is NOT on the road is a detour: the sum through it is longer, never shorter', () => {
    expect(isOnRoute('Gulshan', 'Banani', 'Dhanmondi')).toBe(false); // 2 + 9 = 11 > 10
    expect(km('Gulshan', 'Banani') + km('Banani', 'Dhanmondi')).toBe(11);
  });

  it('the two distances that were inconsistent are fixed', () => {
    expect(km('Dhanmondi', 'Mohakhali')).toBe(7); // was 8: Gulshan → Mohakhali → Dhanmondi added up to 11, not 10
    expect(km('Mohammadpur', 'Uttara')).toBe(14); // was 15: longer than Mohammadpur → Mirpur → Uttara (5 + 9)
  });
});

describe('cost follows the distances', () => {
  const soloThrough = (a: string, b: string, c: string) =>
    segmentFare({ points: [{ zone: a, passengerCount: 1 }, { zone: b, passengerCount: 1 }], exitZone: c, seatCount: 1 }).fare;

  it('riding alone through a zone on the road costs exactly the direct trip cost, for every corridor', () => {
    for (const corridor of ROAD_CORRIDORS) {
      for (let i = 0; i < corridor.length; i++) for (let j = i + 1; j < corridor.length; j++) for (let k = j + 1; k < corridor.length; k++) {
        const [a, b, c] = [corridor[i]!, corridor[j]!, corridor[k]!];
        expect(soloThrough(a, b, c)).toBe(calculateBaseFare(a, c, 1));
      }
    }
    expect(soloThrough('Gulshan', 'Mohakhali', 'Dhanmondi')).toBe(300);
  });

  it('riding alone through ANY zone never costs less than the direct trip', () => {
    for (const a of zones) for (const b of zones) for (const c of zones) {
      if (a === b || b === c || a === c) continue;
      expect(soloThrough(a, b, c)).toBeGreaterThanOrEqual(calculateBaseFare(a, c, 1));
    }
  });

  it('sharing is the one place where a stop adds cost: each shared stretch carries its own ৳20 bonus', () => {
    const direct = segmentFare({ points: [{ zone: 'Gulshan', passengerCount: 2 }], exitZone: 'Dhanmondi', seatCount: 1 }).fare;
    const viaMohakhali = segmentFare({ points: [{ zone: 'Gulshan', passengerCount: 2 }, { zone: 'Mohakhali', passengerCount: 2 }], exitZone: 'Dhanmondi', seatCount: 1 }).fare;
    expect(direct).toBe(170); // 300 / 2 + 20
    expect(viaMohakhali).toBe(190); // (90 / 2 + 20) + (210 / 2 + 20) = 65 + 125: the same road, but two shared stretches
  });
});

describe('buildZoneKm (how the table is kept consistent)', () => {
  const table = (extra: Record<string, Record<string, number>> = {}) => ({
    A: { B: 4, C: 10, ...(extra.A ?? {}) },
    B: { A: 4, C: 6, ...(extra.B ?? {}) },
    C: { A: 10, B: 6, ...(extra.C ?? {}) },
  });

  it('keeps a consistent table as it is', () => {
    const km2 = buildZoneKm(table());
    expect([km2.A!.B, km2.B!.C, km2.A!.C]).toEqual([4, 6, 10]);
  });

  it('shortens an entry that is longer than the way through another zone (no shortcut is left)', () => {
    // A → C is listed as 12 but A → B → C is 4 + 6 = 10
    const km2 = buildZoneKm({ A: { B: 4, C: 12 }, B: { A: 4, C: 6 }, C: { A: 12, B: 6 } });
    expect(km2.A!.C).toBe(10);
    expect(km2.C!.A).toBe(10);
  });

  it('refuses a table that disagrees with itself, or has a missing, fractional or zero distance', () => {
    expect(() => buildZoneKm({ A: { B: 4 }, B: { A: 5 } })).toThrow(/one way and/);
    expect(() => buildZoneKm({ A: { B: 4 }, B: {}, C: { A: 1, B: 1 } } as any)).not.toThrow(); // one direction listed is enough
    expect(() => buildZoneKm({ A: {}, B: {} } as any)).toThrow(/No distance/);
    expect(() => buildZoneKm({ A: { B: 2.5 }, B: { A: 2.5 } })).toThrow(/whole number/);
    expect(() => buildZoneKm({ A: { B: 0 }, B: { A: 0 } })).toThrow(/whole number/);
  });
});
