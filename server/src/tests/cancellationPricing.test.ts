/**
 * The mid-trip cancellation rule, by one worked example you can check by hand.
 *
 *   The passenger who LEAVES pays HALF OF THE FARE THEY WERE QUOTED (a flat, deliberately lenient policy,
 *   not distance-based and not the checkpoint walk). Everyone who STAYS is priced by the ordinary segment
 *   walk over their real checkpoints: the cancellation is only a checkpoint where the count drops by one.
 *
 *   Route A → C is 10 km, tripCost = 100 + 10 × 20 = ৳300, with an exact midpoint M (5 km + 5 km).
 *   Two passengers pooled for the whole trip are each quoted 300 / 2 + 20 = ৳170.
 *   One leaves at M:
 *     the leaver pays   170 / 2                                     = ৳85
 *     the other pays    A → M, 2 on board: 150 / 2 + 20 = 95
 *                       M → C, alone:      150                       = ৳245
 *     revenue           85 + 245 = ৳330   (the two were quoted ৳340 together)
 *
 * The zone table has no zone that is exactly halfway between two others (Gulshan → Dhanmondi is 10 km, but
 * every zone in between adds a detour), so this network is passed to segmentFare directly. The same rule end to end, through the API,
 * on real zones, is in midTripCancellation.test.ts.
 */
import { cancellationFare, segmentFare } from '../utils/fareCalculator';

// A → M → C, 5 km each, 10 km direct
const KM: Record<string, number> = { 'A>M': 5, 'M>C': 5, 'A>C': 10 };
const distanceKm = (from: string, to: string) => (from === to ? 0 : KM[`${from}>${to}`] ?? KM[`${to}>${from}`]!);

describe('cancellation: half of the quoted fare, the others priced by the walk', () => {
  // What both were quoted for the whole trip when they boarded
  const quoted = segmentFare({ points: [{ zone: 'A', passengerCount: 2 }], exitZone: 'C', seatCount: 1, distanceKm });

  it('two passengers pooled for the full trip are each quoted ৳170', () => {
    expect(quoted.soloFare).toBe(300);
    expect(quoted.fare).toBe(170); // 300 / 2 + 20
  });

  it('the cancelling passenger pays 170 / 2 = ৳85', () => {
    expect(cancellationFare(quoted.fare)).toBe(85);
  });

  it('the remaining passenger pays 95 (shared to the midpoint) + 150 (alone after it) = ৳245', () => {
    // Checkpoints: (A, 2) both on board · (M, 1) the other passenger leaves. She rides on alone to C.
    const remaining = segmentFare({
      points: [{ zone: 'A', passengerCount: 2 }, { zone: 'M', passengerCount: 1 }],
      exitZone: 'C',
      seatCount: 1,
      distanceKm,
    });
    expect(remaining.segments.map((s) => [s.fromZone, s.toZone, s.distanceKm, s.passengers, s.driverBonus, s.charge])).toEqual([
      ['A', 'M', 5, 2, 20, 95], // segment tripCost 150: 150 / 2 + 20
      ['M', 'C', 5, 1, 0, 150], // segment tripCost 150, alone: no split, no bonus
    ]);
    expect(remaining.fare).toBe(245);
  });

  it('total revenue is 85 + 245 = ৳330, against ৳340 if nobody had left', () => {
    const remaining = segmentFare({
      points: [{ zone: 'A', passengerCount: 2 }, { zone: 'M', passengerCount: 1 }],
      exitZone: 'C',
      seatCount: 1,
      distanceKm,
    });
    expect(cancellationFare(quoted.fare) + remaining.fare).toBe(330);
    expect(quoted.fare * 2).toBe(340);
    expect(quoted.fare * 2 - (cancellationFare(quoted.fare) + remaining.fare)).toBe(10);
  });
});

describe('cancellationFare (the rounding)', () => {
  it('is half of the quote, to the nearest whole taka, halves up', () => {
    expect(cancellationFare(170)).toBe(85);
    expect(cancellationFare(113)).toBe(57); // 56.5 rounds up
    expect(cancellationFare(420)).toBe(210);
    expect(cancellationFare(1)).toBe(1);
    expect(cancellationFare(0)).toBe(0);
  });

  it('is always a whole number of taka and never more than the quote', () => {
    for (let q = 0; q <= 2000; q++) {
      const c = cancellationFare(q);
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBe(Math.round(q / 2 + 1e-9)); // an independent way to say "half, halves up"
      expect(c).toBeLessThanOrEqual(q);
    }
  });

  it('refuses a quote that is not a whole number of taka', () => {
    expect(() => cancellationFare(12.5)).toThrow();
    expect(() => cancellationFare(-10)).toThrow();
    expect(() => cancellationFare(NaN)).toThrow();
  });
});
