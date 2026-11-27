// Whether a page says, in its own words, that the posting is no longer open.
//
// Asked only where no application was found: a page with a form on it is
// taken at its form, whatever else it says. Kept apart from the applier so
// it can be checked without a browser.

export const GONE_RE =
  /\b(this |the )?(job|position|posting|opportunity|requisition|role|opening|vacancy)\b[^.\n]{0,40}\b(is no longer|no longer|is not|isn'?t) (available|accepting|open|active|posted)|\b(has been|was|is) (filled|closed|removed|taken down|expired)\b[^.\n]{0,30}$|\bno longer accepting applications\b|\b(job|position|posting|opportunity) (has )?(expired|closed)\b|\bthis (job|position|posting|opportunity) (is )?(closed|filled|expired|unavailable)\b/im;
