/**
 * The direction-aware pool rules (utils/routeDirection.ts), checked with numbers that can be
 * worked out by hand.
 *
 * Grid points used below (x east, y north, 1 unit ≈ 0.5 km):
 *   Mohakhali (11,11)   Gulshan 1 (14,11)   Badda (15,11)   Banani (12,14)   Gulshan (13,14)
 *   Dhanmondi (5,4)     Motijheel (14,1)    Mirpur (4,17)   Uttara (6,32)    Mohammadpur (2,8)
 *
 * RULE A — a trip that has not started. Existing A→B, candidate C→D (u = B−A, v = D−C, w = C−A):
 *   1. angle(u, v) ≤ 45°           u·v > 0  and  2(u·v)² ≥ |u|²|v|²
 *   2. C within 4 units of line AB  (u×w)² ≤ 16|u|²
 *   3. the trips overlap            u·w < |u|²  and  u·(D−A) > 0
 *
 * RULE B — a trip under way. P = pickup of the most recently started onboard ride, F = the onboard
 * destination farthest from P, u = F−P, w = C−P:
 *   a1. u·w ≥ 0   a2. u·w < |u|²   a3. (u×w)² ≤ 4|u|²        (pickup on the road ahead, ≤ 1 km off it)
 *   b1. angle to every onboard passenger's own route ≤ 45°
 *   b2. (u×(D−P))² ≤ 16|u|²                                    (destination ≤ 2 km off the road)
 */
import { DHAKA_ZONES } from '../models/RideRequest';
import {
  ZONE_COORDS,
  checkOnboardRoute,
  checkRoutes,
  onboardRoute,
  areRoutesCompatible,
  zonesWithoutCoordinates,
} from '../utils/routeDirection';

const leg = (pickupZone: string, destinationZone: string) => ({ pickupZone, destinationZone });
const onboard = (pickupZone: string, destinationZone: string, order = 1) => ({ pickupZone, destinationZone, order });

describe('routeDirection — direction-aware pool compatibility', () => {
  it('every zone the app offers has a grid point, and no two zones share one', () => {
    expect(zonesWithoutCoordinates()).toEqual([]);
    const points = DHAKA_ZONES.map((z) => `${ZONE_COORDS[z]!.x},${ZONE_COORDS[z]!.y}`);
    expect(new Set(points).size).toBe(DHAKA_ZONES.length);
  });

  describe('RULE A — a trip that has not started', () => {
    it('an identical route is always compatible', () => {
      for (const from of DHAKA_ZONES) {
        for (const to of DHAKA_ZONES) {
          if (from !== to) expect(areRoutesCompatible(leg(from, to), leg(from, to))).toBe(true);
        }
      }
    });

    it('accepts a shorter trip the same way, and a parallel road within 2 km', () => {
      // Mohakhali→Badda u = (4,0). Mohakhali→Gulshan 1: v = (3,0).
      expect(checkRoutes(leg('Mohakhali', 'Badda'), leg('Mohakhali', 'Gulshan 1'))).toEqual({ compatible: true });
      // Banani→Gulshan: v = (1,0); w = (1,3): u×w = 12, 144 ≤ 16·16 = 256; u·w = 4 < 16; u·(D−A) = 8 > 0.
      expect(checkRoutes(leg('Mohakhali', 'Badda'), leg('Banani', 'Gulshan'))).toEqual({ compatible: true });
    });

    it('rejects Mohakhali → Gulshan: 56° off (v = (2,3): u·v = 8, 2·64 = 128 < 16·13 = 208)', () => {
      expect(checkRoutes(leg('Mohakhali', 'Badda'), leg('Mohakhali', 'Gulshan'))).toEqual({ compatible: false, reason: 'DIRECTION' });
    });

    it('rejects an unrelated route: Mohakhali → Dhanmondi heads the opposite way (u·v = −24)', () => {
      expect(checkRoutes(leg('Mohakhali', 'Badda'), leg('Mohakhali', 'Dhanmondi'))).toEqual({ compatible: false, reason: 'DIRECTION' });
      expect(areRoutesCompatible(leg('Mohakhali', 'Badda'), leg('Badda', 'Mohakhali'))).toBe(false);
    });

    it('rejects a pickup far from the route (corridor)', () => {
      // Dhanmondi→Motijheel u = (9,−3), |u|² = 90. Mirpur→Badda v = (11,−6): direction fine (2·117² = 27378 ≥ 14130),
      // but w = (−1,13): u×w = 114, 114² = 12996 > 16·90 = 1440.
      expect(checkRoutes(leg('Dhanmondi', 'Motijheel'), leg('Mirpur', 'Badda'))).toEqual({ compatible: false, reason: 'CORRIDOR' });
    });

    it('rejects a pickup at or after the end of the existing trip (no overlap)', () => {
      // Mohakhali→Gulshan 1 u = (3,0), |u|² = 9; Gulshan 1→Badda: w = (3,0), u·w = 9 = |u|².
      expect(checkRoutes(leg('Mohakhali', 'Gulshan 1'), leg('Gulshan 1', 'Badda'))).toEqual({ compatible: false, reason: 'NO_OVERLAP' });
    });

    it('keeps the old pre-trip behaviour: Gulshan → Banani does not pool with Gulshan → Dhanmondi', () => {
      // u = (−1,0), v = (−8,−10): u·v = 8, 2·64 = 128 < 164.
      expect(checkRoutes(leg('Gulshan', 'Banani'), leg('Gulshan', 'Dhanmondi'))).toEqual({ compatible: false, reason: 'DIRECTION' });
    });
  });

  describe('RULE B — a trip under way: Nusrat rides Mohakhali → Badda   (P = (11,11), F = (15,11), u = (4,0), |u|² = 16)', () => {
    const nusrat = [onboard('Mohakhali', 'Badda')];

    it('works out the vehicle’s route from the rides on board', () => {
      expect(onboardRoute(nusrat)).toEqual({ position: 'Mohakhali', finalDestination: 'Badda' });
      // The most recently started ride gives the position; the farthest destination from it is the end.
      expect(onboardRoute([onboard('Mohakhali', 'Badda', 1), onboard('Mohakhali', 'Gulshan 1', 2)])).toEqual({
        position: 'Mohakhali',
        finalDestination: 'Badda',
      });
      expect(onboardRoute([onboard('Mohakhali', 'Badda', 1), onboard('Gulshan 1', 'Badda', 2)])).toEqual({
        position: 'Gulshan 1',
        finalDestination: 'Badda',
      });
    });

    it('accepts a pickup on the road and a destination shorter than, equal to, or (see below) beyond hers', () => {
      // Mohakhali → Gulshan 1: w = 0; v = (3,0); D−P = (3,0): cross 0.
      expect(checkOnboardRoute(nusrat, leg('Mohakhali', 'Gulshan 1'))).toEqual({ compatible: true });
      expect(checkOnboardRoute(nusrat, leg('Mohakhali', 'Badda'))).toEqual({ compatible: true });
      // Gulshan 1 → Badda: w = (3,0), u·w = 12: 0 ≤ 12 < 16.
      expect(checkOnboardRoute(nusrat, leg('Gulshan 1', 'Badda'))).toEqual({ compatible: true });
    });

    it('rejects a pickup that needs a detour: Banani → Gulshan is 1.5 km off the road (was fine before the trip)', () => {
      // w = (1,3): u×w = 12, 144 > 2²·16 = 64.
      expect(checkOnboardRoute(nusrat, leg('Banani', 'Gulshan'))).toEqual({ compatible: false, reason: 'PICKUP_OFF_ROUTE' });
      expect(checkOnboardRoute(nusrat, leg('Gulshan', 'Gulshan 1'))).toEqual({ compatible: false, reason: 'DIRECTION' });
    });

    it('rejects a pickup behind the car', () => {
      // Existing Gulshan 1 → Badda (P = (14,11)): Mohakhali is at w = (−3,0), u·w = −3 < 0.
      expect(checkOnboardRoute([onboard('Gulshan 1', 'Badda')], leg('Mohakhali', 'Badda'))).toEqual({
        compatible: false,
        reason: 'PICKUP_BEHIND',
      });
    });

    it('rejects a pickup at the end of the road (nothing left to share)', () => {
      // Badda: w = (4,0), u·w = 16 = |u|². Badda → Mohakhali fails direction first, so use a route the same way.
      // Existing Mohakhali → Gulshan 1 (u = (3,0)), candidate Gulshan 1 → Badda: u·w = 9 = |u|².
      expect(checkOnboardRoute([onboard('Mohakhali', 'Gulshan 1')], leg('Gulshan 1', 'Badda'))).toEqual({
        compatible: false,
        reason: 'PICKUP_PAST_END',
      });
    });

    it('rejects a destination that does not continue the same way', () => {
      for (const to of ['Dhanmondi', 'Uttara', 'Motijheel', 'Mirpur', 'Mohammadpur', 'Gulshan', 'Banani']) {
        expect(checkOnboardRoute(nusrat, leg('Mohakhali', to)).compatible).toBe(false);
      }
      expect(checkOnboardRoute(nusrat, leg('Mohakhali', 'Dhanmondi'))).toEqual({ compatible: false, reason: 'DIRECTION' });
    });

    it('rejects a destination that is within 45° but drifts more than 2 km off the road', () => {
      // Existing Mohakhali → Banani: u = (1,3), |u|² = 10. Mohakhali → Uttara: v = (−5,21); u·v = 58, 2·3364 = 6728 ≥ 10·466 = 4660 ✓.
      // But u×(D−P) = 1·21 − 3·(−5) = 36; 1296 > 16·10 = 160.
      expect(checkOnboardRoute([onboard('Mohakhali', 'Banani')], leg('Mohakhali', 'Uttara'))).toEqual({
        compatible: false,
        reason: 'DESTINATION_OFF_ROUTE',
      });
    });

    it('must fit EVERY onboard passenger’s direction, not just the last one to start', () => {
      // Nusrat (Mohakhali→Badda) and Rafiq (Mohakhali→Gulshan 1) are both on board; nobody may head off the way of either.
      const both = [onboard('Mohakhali', 'Badda', 1), onboard('Mohakhali', 'Gulshan 1', 2)];
      expect(checkOnboardRoute(both, leg('Mohakhali', 'Badda'))).toEqual({ compatible: true });
      expect(checkOnboardRoute(both, leg('Mohakhali', 'Gulshan'))).toEqual({ compatible: false, reason: 'DIRECTION' });
    });
  });
});
