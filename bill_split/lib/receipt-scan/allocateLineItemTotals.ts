// Splits a receipt's tax+tip proportionally across its line items, then fixes up the
// rounding so the items' totals always sum to EXACTLY the receipt's real total — never off
// by a cent or two the way naive "round each share independently" math would be.
//
// Why naive rounding breaks: if three items split $0.10 of tax proportionally, each share
// might round to its own nearest cent, but those three roundings don't generally add back up
// to exactly $0.10. This uses the standard "largest remainder" method instead (the same
// technique used for allocating seats/votes fairly): compute every item's raw unrounded
// share, round all of them DOWN, then hand out the few leftover cents one at a time to
// whichever items had the largest fractional remainder. The result always sums exactly to
// the target, and no single item absorbs all the rounding slack.
export function allocateLineItemTotals(rawItemCosts: number[], targetTotal: number): number[] {
  if (rawItemCosts.length === 0) return [];

  const subtotal = rawItemCosts.reduce((sum, cost) => sum + cost, 0);
  const targetCents = Math.round(targetTotal * 100);

  // Each item's raw (unrounded) share of the target, in cents. If every item is $0 (e.g. a
  // brand-new row the user hasn't filled in yet), split the target evenly instead of
  // dividing by a zero subtotal.
  const rawShareCents = rawItemCosts.map((cost) =>
    subtotal > 0 ? (cost / subtotal) * targetCents : targetCents / rawItemCosts.length
  );

  const flooredCents = rawShareCents.map((cents) => Math.floor(cents));
  const flooredTotal = flooredCents.reduce((sum, cents) => sum + cents, 0);
  let leftoverCents = targetCents - flooredTotal;

  // Give the leftover pennies to the items whose floor() cut off the most — i.e. the
  // largest fractional remainder — so the few cents of rounding slack land on the items
  // that "deserved" them most, rather than arbitrarily on the first or last row.
  const remainders = rawShareCents
    .map((cents, index) => ({ index, fraction: cents - Math.floor(cents) }))
    .sort((a, b) => b.fraction - a.fraction);

  const resultCents = [...flooredCents];
  for (let i = 0; i < remainders.length && leftoverCents > 0; i++) {
    resultCents[remainders[i].index] += 1;
    leftoverCents--;
  }

  return resultCents.map((cents) => cents / 100);
}
