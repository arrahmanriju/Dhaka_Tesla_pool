/**
 * Pro-rated fare for a passenger who leaves a STARTED ride at a zone of their choice.
 *
 *   fare = ৳100 + distanceKm(pickup → cancellation zone) × ৳20 × seats − poolDiscount
 *
 * with the poolDiscount quoted at match time. Distances come from the same table as the original
 * estimate (fareCalculator.ts): Uttara–Mirpur 9 km, Uttara–Motijheel 18 km, Mohakhali–Banani 2 km …
 */
import { applyShareRate, calculateBaseFare, prorateFare } from '../utils/fareCalculator';

describe('prorateFare', () => {
  it('worked example: Uttara → Motijheel (18 km, ৳460 solo) shared by 2, cancelled at Mirpur (9 km)', () => {
    const base = calculateBaseFare('Uttara', 'Motijheel', 1); // 100 + 18×20 = 460
    const locked = applyShareRate(base, 2); // 70% of 460 = 322 → ৳320
    expect(base).toBe(460);
    expect(locked).toBe(320);
    const poolDiscount = base - locked; // ৳140

    const r = prorateFare('Uttara', 'Mirpur', 1, poolDiscount, locked);
    expect(r).toMatchObject({ baseCharge: 100, distanceKm: 9, distanceCharge: 180, grossFare: 280, poolDiscount: 140, fare: 140, limited: false });
  });

  it('with no pool discount the passenger pays the plain fare for the part travelled', () => {
    // Uttara → Motijheel alone (locked ৳460), left at Mirpur: 100 + 9×20 = ৳280
    expect(prorateFare('Uttara', 'Mirpur', 1, 0, 460).fare).toBe(280);
  });

  it('scales the distance charge with the number of seats, not the base charge', () => {
    // 2 seats, Mohakhali → Banani (2 km): 100 + 2×20×2 = ৳180
    expect(prorateFare('Mohakhali', 'Banani', 2, 0, 500)).toMatchObject({ distanceCharge: 80, grossFare: 180, fare: 180 });
  });

  it('a partway zone costs less than the full trip; the full-trip fare uses the same formula', () => {
    const full = prorateFare('Uttara', 'Motijheel', 1, 0, 460);
    expect(full.fare).toBe(calculateBaseFare('Uttara', 'Motijheel', 1));
    expect(prorateFare('Uttara', 'Mirpur', 1, 0, 460).fare).toBeLessThan(full.fare);
  });

  it('never goes below ৳0 when the discount is bigger than the short fare', () => {
    // Gulshan → Uttara, 3 seats, pool of 3: solo 100 + 12×60 = 820, 55% = 451 → ৳450, discount ৳370.
    // Left at Gulshan 1 (1 km): 100 + 60 = 160 − 370 < 0
    const locked = applyShareRate(820, 3);
    const r = prorateFare('Gulshan', 'Gulshan 1', 3, 820 - locked, locked);
    expect(locked).toBe(450);
    expect(r).toMatchObject({ grossFare: 160, poolDiscount: 370, fare: 0, limited: true });
  });

  it('never charges more than the locked fare for the whole trip', () => {
    // Mohakhali → Badda is ৳180; Uttara is 11 km from Mohakhali (100 + 220 = ৳320) but the fare is capped at ৳180.
    expect(prorateFare('Mohakhali', 'Uttara', 1, 0, 180)).toMatchObject({ grossFare: 320, fare: 180, limited: true });
  });

  it('rejects an unknown zone', () => {
    expect(() => prorateFare('Mohakhali', 'Narnia', 1, 0, 180)).toThrow();
  });
});
