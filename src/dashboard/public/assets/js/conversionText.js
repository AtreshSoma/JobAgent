/**
 * The words for one "What gets interviews" cell (P2-9, F9). Pure, so it can be
 * tested without a browser.
 */
/** One conversion cell, in words: "2 of 9 (22%)" or "3 sent; too few to tell". Pure. */
export function conversionText(cell, minCell = 5) {
  if (cell.tooFew) return `${cell.submitted} sent; too few to tell (needs ${minCell})`;
  const interviews = `${cell.interviews} of ${cell.submitted} reached an interview (${cell.interviewRate}%)`;
  return cell.offerRate == null ? interviews
    : `${interviews}; ${cell.offers} of ${cell.interviews} interviews became an offer (${cell.offerRate}%)`;
}
