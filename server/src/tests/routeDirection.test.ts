/**
 * The direction-aware pool rule (utils/routeDirection.ts), checked with numbers that can be
 * worked out by hand.
 *
 * Grid points used below (x east, y north, 1 unit ≈ 0.5 km):
 *   Mohakhali (11,11)   Gulshan 1 (14,11)   Badda (15,11)   Banani (12,14)   Gulshan (13,14)
 *   Dhanmondi (5,4)     Motijheel (14,1)    Mirpur (4,17)   Uttara (6,32)    Mohammadpur (2,8)
 *
 * Rule for an existing route A→B and a candidate C→D (u = B−A, v = D−C, w = C−A):
 *   1. angle(u, v) ≤ 45°           u·v > 0  and  2(u·v)² ≥ |u|²|v|²
 *   2. C within 4 units of line AB  (u×w)² ≤ 16|u|²
 *   3. the trips overlap            u·w < |u|²  and  u·(D−A) > 0
 *   4. if the existing trip STARTED, C is not behind A:  u·w ≥ 0
 */
import { DHAKA_ZONES } from '../models/RideRequest';
import { ZONE_COORDS, checkRoutes, areRoutesCompatible, zonesWithoutCoordinates } from '../utils/routeDirection';

const leg = (pickupZone: string, destinationZone: string, started = false) => ({ pickupZone, destinationZone, started });

describe('routeDirection — direction-aware pool compatibility', () => {
  it('every zone the app offers has a grid point, and no two zones share one', () => {
    expect(zonesWithoutCoordinates()).toEqual([]);
    const points = DHAKA_ZONES.map((z) => `${ZONE_COORDS[z]!.x},${ZONE_COORDS[z]!.y}`);
    expect(new Set(points).size).toBe(DHAKA_ZONES.length);
  });

  it('an identical route is always compatible, started or not', () => {
    for (const from of DHAKA_ZONES) {
      for (const to of DHAKA_ZONES) {
        if (from === to) continue;
        expect(areRoutesCompatible(leg(from, to), leg(from, to))).toBe(true);
        expect(areRoutesCompatible(leg(from, to, true), leg(from, to))).toBe(true);
      }
    }
  });

  describe('Nusrat rides Mohakhali → Badda   (u = (4,0), |u|² = 16)', () => {
    const nusrat = leg('Mohakhali', 'Badda', true);

    it('accepts Mohakhali → Gulshan 1: a shorter trip the same way (v = (3,0))', () => {
      expect(checkRoutes(nusrat, leg('Mohakhali', 'Gulshan 1'))).toEqual({ compatible: true });
    });

    it('accepts Banani → Gulshan: a parallel road, 1.5 km off the line, heading the same way', () => {
      // v = (1,0): angle 0°.  w = (1,3): u×w = 12, 12² = 144 ≤ 16·16 = 256.  u·w = 4 < 16.  u·(D−A) = 8 > 0.  u·w ≥ 0.
      expect(checkRoutes(nusrat, leg('Banani', 'Gulshan'))).toEqual({ compatible: true });
    });

    it('accepts Gulshan 1 → Badda: picked up part-way along the same route', () => {
      // w = (3,0): u·w = 12 < 16.  v = (1,0).
      expect(checkRoutes(nusrat, leg('Gulshan 1', 'Badda'))).toEqual({ compatible: true });
    });

    it('rejects Mohakhali → Gulshan: 56° off (v = (2,3): u·v = 8, 2·64 = 128 < 16·13 = 208)', () => {
      expect(checkRoutes(nusrat, leg('Mohakhali', 'Gulshan'))).toEqual({ compatible: false, reason: 'DIRECTION' });
    });

    it('rejects a genuinely unrelated route: Mohakhali → Dhanmondi heads the opposite way (u·v < 0)', () => {
      // v = (−6,−7): u·v = −24
      expect(checkRoutes(nusrat, leg('Mohakhali', 'Dhanmondi'))).toEqual({ compatible: false, reason: 'DIRECTION' });
      expect(areRoutesCompatible(nusrat, leg('Mohakhali', 'Uttara'))).toBe(false);
      expect(areRoutesCompatible(nusrat, leg('Mohakhali', 'Motijheel'))).toBe(false);
    });

    it('rejects the reverse trip Badda → Mohakhali', () => {
      expect(checkRoutes(nusrat, leg('Badda', 'Mohakhali'))).toEqual({ compatible: false, reason: 'DIRECTION' });
    });
  });

  it('rejects a candidate whose pickup is far from the existing route (corridor)', () => {
    // Existing Dhanmondi → Motijheel: u = (9,−3), |u|² = 90.  Candidate Mirpur → Badda: v = (11,−6),
    // u·v = 117, 2·117² = 27378 ≥ 90·157 = 14130, so the direction is fine.
    // But w = (−1,13): u×w = 114, 114² = 12996 > 16·90 = 1440 → too far from the line.
    expect(checkRoutes(leg('Dhanmondi', 'Motijheel'), leg('Mirpur', 'Badda'))).toEqual({
      compatible: false,
      reason: 'CORRIDOR',
    });
  });

  it('rejects a candidate who would be picked up after the existing trip ends (no overlap)', () => {
    // Existing Mohakhali → Gulshan 1: u = (3,0), |u|² = 9.  Candidate Gulshan 1 → Badda: w = (3,0), u·w = 9 = |u|².
    expect(checkRoutes(leg('Mohakhali', 'Gulshan 1'), leg('Gulshan 1', 'Badda'))).toEqual({
      compatible: false,
      reason: 'NO_OVERLAP',
    });
  });

  it('a started trip cannot go back for someone behind its start; an unstarted one can', () => {
    // Existing Gulshan 1 → Badda: u = (1,0).  Candidate Mohakhali → Badda: w = (−3,0), u·w = −3 < 0.
    expect(checkRoutes(leg('Gulshan 1', 'Badda', true), leg('Mohakhali', 'Badda'))).toEqual({
      compatible: false,
      reason: 'BEHIND_TRIP',
    });
    expect(checkRoutes(leg('Gulshan 1', 'Badda', false), leg('Mohakhali', 'Badda'))).toEqual({ compatible: true });
  });

  it('keeps the old pre-trip behaviour: Gulshan → Banani does not pool with Gulshan → Dhanmondi', () => {
    // u = (−1,0), v = (−8,−10): u·v = 8, 2·64 = 128 < 1·164 → 51°.
    expect(checkRoutes(leg('Gulshan', 'Banani'), leg('Gulshan', 'Dhanmondi'))).toEqual({
      compatible: false,
      reason: 'DIRECTION',
    });
  });
});
