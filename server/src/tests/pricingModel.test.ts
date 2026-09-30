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
 * The pool changes at CHECKPOINTS. Mohakhali lies on the Gulshan → Dhanmondi road and the zone distances
 * add up along it (Gulshan → Mohakhali 3 km + Mohakhali → Dhanmondi 7 km = 10 km, see zoneDistances.test.ts), so
 * a checkpoint there does not change the journey's length or its trip cost (৳300). What does change is that
 * each stretch shared by two or more carries its own ৳20 bonus.
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
    // Three riders, Gulshan → Dhanmondi. Checkpoints are at Mohakhali (3 km from Gulshan, 7 km from Dhanmondi).
    // Their journey is 3 + 7 = 10 km, the same as direct, so tripCost = ৳300; a segment gets segKm / 10 of it.

    it('joins at Mohakhali (after Gulshan) and rides on to Dhanmondi', () => {
      // Gulshan → Mohakhali: 3 riders.  Mohakhali → Dhanmondi: 4 riders.
      const through = segmentFare({
        points: [{ zone: 'Gulshan', passengerCount: 3 }, { zone: 'Mohakhali', passengerCount: 4 }],
        exitZone: 'Dhanmondi',
        seatCount: 1,
      });
      // 3 km: 3/10 × 300 = 90, / 3 = 30, + 20 = 50
      // 7 km: 7/10 × 300 = 210, / 4 = 52.5 → rounded UP to 53, + 20 = 73      fare 50 + 73 = ৳123
      expect(through.soloFare).toBe(300);
      expect(through.segments.map((s) => [s.distanceKm, s.passengers, s.driverBonus, s.charge])).toEqual([
        [3, 3, 20, 50],
        [7, 4, 20, 73],
      ]);
      expect(through.fare).toBe(123);

      // The fourth passenger boards at Mohakhali: one 7 km segment with 4 on board. journeyKm 7, tripCost 100 + 140 = ৳240.
      const partial = segmentFare({ points: [{ zone: 'Mohakhali', passengerCount: 4 }], exitZone: 'Dhanmondi', seatCount: 1 });
      expect(partial.soloFare).toBe(240);
      expect(partial.fare).toBe(80); // 240 / 4 + 20 = 60 + 20

      // Different from each other, and from the full-route numbers above
      expect(partial.fare).toBeLessThan(through.fare);
      expect(partial.fare).not.toBe(wholeRoute(3).fare); // 120
      expect(through.fare).not.toBe(wholeRoute(3).fare);
      expect(through.fare * 3 + partial.fare).toBe(449); // the driver earns 3 × 123 + 80
    });

    it('rides from Gulshan but leaves at Mohakhali, before Dhanmondi', () => {
      // Gulshan → Mohakhali: 4 riders.  Mohakhali → Dhanmondi: 3 riders (the fourth has left).
      const stay = segmentFare({
        points: [{ zone: 'Gulshan', passengerCount: 4 }, { zone: 'Mohakhali', passengerCount: 3 }],
        exitZone: 'Dhanmondi',
        seatCount: 1,
      });
      // 3 km: 3/10 × 300 = 90, / 4 = 22.5 → rounded UP to 23, + 20 = 43
      // 7 km: 7/10 × 300 = 210, / 3 = 70, + 20 = 90      fare 43 + 90 = ৳133
      expect(stay.segments.map((s) => [s.distanceKm, s.passengers, s.charge])).toEqual([
        [3, 4, 43],
        [7, 3, 90],
      ]);
      expect(stay.fare).toBe(133);

      // The one who leaves: a single 3 km segment with 4 on board. journeyKm 3, tripCost 100 + 60 = ৳160.
      const leaver = segmentFare({ points: [{ zone: 'Gulshan', passengerCount: 4 }], exitZone: 'Mohakhali', seatCount: 1 });
      expect(leaver.soloFare).toBe(160);
      expect(leaver.fare).toBe(60); // 160 / 4 + 20 = 40 + 20

      expect(leaver.fare).toBeLessThan(stay.fare);
      expect(stay.fare * 3 + leaver.fare).toBe(459); // 3 × 133 + 60
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
