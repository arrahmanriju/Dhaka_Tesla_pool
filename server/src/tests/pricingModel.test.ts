/**
 * The pricing model, by one worked example you can check by hand: Gulshan → Dhanmondi.
 *
 *   Gulshan → Dhanmondi is 10 km, so tripCost = ৳100 + 10 × ৳20 = ৳300 (1 seat).
 *
 *   1 rider on the segment:    fare = tripCost                          = ৳300
 *   n ≥ 2 riders on it:        fare = tripCost / n + ৳20 driver bonus
 *        2 riders:  300 / 2 + 20 = 150 + 20 = ৳170 each   (the driver earns ৳340)
 *        3 riders:  300 / 3 + 20 = 100 + 20 = ৳120 each   (the driver earns ৳360)
 *        4 riders:  300 / 4 + 20 =  75 + 20 =  ৳95 each   (the driver earns ৳380)
 *
 * A passenger's total is the sum over the segments they were on board for. A segment's trip cost is the
 * passenger's trip cost spread over THEIR journey by distance (segKm / journeyKm), so the pieces add up
 * to the whole. Rounding: a shared split that does not divide evenly is rounded UP to the next whole
 * taka for every passenger on the segment (see fareCalculator.ts and roundingRule.test.ts).
 *
 * The pool changes at CHECKPOINTS, and the zone table is not additive: Gulshan → Mohakhali is 3 km and
 * Mohakhali → Dhanmondi is 8 km, 11 km in total against 10 km direct. So once a checkpoint at Mohakhali
 * exists, a rider going the whole way is priced over 11 km (tripCost 100 + 11 × 20 = ৳320), not 10.
 */
import { pooledFare, segmentFare } from '../utils/fareCalculator';

const wholeRoute = (riders: number) =>
  segmentFare({ points: [{ zone: 'Gulshan', passengerCount: riders }], exitZone: 'Dhanmondi', seatCount: 1 });

describe('Gulshan → Dhanmondi, tripCost ৳300', () => {
  it('a solo rider pays the trip cost, ৳300', () => {
    const solo = wholeRoute(1);
    expect(solo.soloFare).toBe(300);
    expect(solo.fare).toBe(300);
    expect(solo.poolDiscount).toBe(0);
    expect(solo.segments).toEqual([
      { fromZone: 'Gulshan', toZone: 'Dhanmondi', distanceKm: 10, passengers: 1, driverBonus: 0, charge: 300 },
    ]);
  });

  it('2 riders pay 300 / 2 + 20 = ৳170 each', () => {
    const two = wholeRoute(2);
    expect(two.fare).toBe(170);
    expect(two.segments).toEqual([
      { fromZone: 'Gulshan', toZone: 'Dhanmondi', distanceKm: 10, passengers: 2, driverBonus: 20, charge: 170 },
    ]);
    expect(two.poolDiscount).toBe(130); // 300 − 170
    expect(two.fare * 2).toBe(340); // the driver earns 340 for a trip that costs 300 alone
  });

  it('3 riders pay 300 / 3 + 20 = ৳120 each', () => {
    const three = wholeRoute(3);
    expect(three.fare).toBe(120);
    expect(three.poolDiscount).toBe(180);
    expect(three.fare * 3).toBe(360);
  });

  it('4 riders pay 300 / 4 + 20 = ৳95 each: the split has no upper limit, the ৳20 stays', () => {
    expect(wholeRoute(4).fare).toBe(95);
  });

  it('the quote used before a ride (pooledFare) is the same number', () => {
    expect([1, 2, 3, 4].map((n) => pooledFare('Gulshan', 'Dhanmondi', 1, n))).toEqual([300, 170, 120, 95]);
  });

  it('a private ride stays ৳300 whatever the count', () => {
    expect(segmentFare({ points: [{ zone: 'Gulshan', passengerCount: 3 }], exitZone: 'Dhanmondi', seatCount: 1, allowSharing: false }).fare).toBe(300);
  });

  describe('a fourth passenger for only PART of the route', () => {
    // Three riders, Gulshan → Dhanmondi. Checkpoints are at Mohakhali (3 km from Gulshan, 8 km from Dhanmondi).
    // Their journey is 3 + 8 = 11 km, so tripCost = 100 + 11 × 20 = ৳320; a segment gets segKm / 11 of it.

    it('joins at Mohakhali (after Gulshan) and rides on to Dhanmondi', () => {
      // Gulshan → Mohakhali: 3 riders.  Mohakhali → Dhanmondi: 4 riders.
      const through = segmentFare({
        points: [{ zone: 'Gulshan', passengerCount: 3 }, { zone: 'Mohakhali', passengerCount: 4 }],
        exitZone: 'Dhanmondi',
        seatCount: 1,
      });
      // 3 km: 3/11 × 320 = 87.27, / 3 = 29.09 → rounded UP to 30, + 20 = 50
      // 8 km: 8/11 × 320 = 232.73, / 4 = 58.18 → rounded UP to 59, + 20 = 79      fare 50 + 79 = ৳129
      expect(through.soloFare).toBe(320);
      expect(through.segments.map((s) => [s.distanceKm, s.passengers, s.driverBonus, s.charge])).toEqual([
        [3, 3, 20, 50],
        [8, 4, 20, 79],
      ]);
      expect(through.fare).toBe(129);

      // The fourth passenger boards at Mohakhali: one 8 km segment with 4 on board. journeyKm 8, tripCost 100 + 160 = ৳260.
      const partial = segmentFare({ points: [{ zone: 'Mohakhali', passengerCount: 4 }], exitZone: 'Dhanmondi', seatCount: 1 });
      expect(partial.soloFare).toBe(260);
      expect(partial.fare).toBe(85); // 260 / 4 + 20 = 65 + 20

      // Different from each other, and from the full-route numbers above
      expect(partial.fare).toBeLessThan(through.fare);
      expect(partial.fare).not.toBe(wholeRoute(3).fare); // 120
      expect(through.fare).not.toBe(wholeRoute(3).fare);
      expect(through.fare * 3 + partial.fare).toBe(472); // the driver earns 3 × 129 + 85
    });

    it('rides from Gulshan but leaves at Mohakhali, before Dhanmondi', () => {
      // Gulshan → Mohakhali: 4 riders.  Mohakhali → Dhanmondi: 3 riders (the fourth has left).
      const stay = segmentFare({
        points: [{ zone: 'Gulshan', passengerCount: 4 }, { zone: 'Mohakhali', passengerCount: 3 }],
        exitZone: 'Dhanmondi',
        seatCount: 1,
      });
      // 3 km: 3/11 × 320 = 87.27, / 4 = 21.82 → rounded UP to 22, + 20 = 42
      // 8 km: 8/11 × 320 = 232.73, / 3 = 77.58 → rounded UP to 78, + 20 = 98      fare 42 + 98 = ৳140
      expect(stay.segments.map((s) => [s.distanceKm, s.passengers, s.charge])).toEqual([
        [3, 4, 42],
        [8, 3, 98],
      ]);
      expect(stay.fare).toBe(140);

      // The one who leaves: a single 3 km segment with 4 on board. journeyKm 3, tripCost 100 + 60 = ৳160.
      const leaver = segmentFare({ points: [{ zone: 'Gulshan', passengerCount: 4 }], exitZone: 'Mohakhali', seatCount: 1 });
      expect(leaver.soloFare).toBe(160);
      expect(leaver.fare).toBe(60); // 160 / 4 + 20 = 40 + 20

      expect(leaver.fare).toBeLessThan(stay.fare);
      expect(stay.fare * 3 + leaver.fare).toBe(480); // 3 × 140 + 60
    });

    it('every rider on a segment pays that segment once: each passenger’s charges add up to their fare', () => {
      const bills = [
        segmentFare({ points: [{ zone: 'Gulshan', passengerCount: 3 }, { zone: 'Mohakhali', passengerCount: 4 }], exitZone: 'Dhanmondi', seatCount: 1 }),
        segmentFare({ points: [{ zone: 'Mohakhali', passengerCount: 4 }], exitZone: 'Dhanmondi', seatCount: 1 }),
      ];
      for (const bill of bills) {
        expect(bill.segments.reduce((sum, s) => sum + s.charge, 0)).toBe(bill.fare);
        expect(bill.segments.every((s) => Number.isInteger(s.charge))).toBe(true);
      }
    });
  });
});
