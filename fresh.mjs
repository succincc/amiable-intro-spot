// How old a posting may be and still be applied to.
//
// It was fourteen days. The owner raised it to thirty: at fourteen, the rule
// was turning away more postings than every other rule together, and the
// applier was finishing its whole queue each round with hours to spare. The
// newest are still taken first, so a posting in its first days is answered
// in its first days; the older ones are what the rest of each round is
// spent on. One number, kept here, so that every reader and the applier
// agree on it. (The panel keeps the same number in discover.server.ts.)

export const FRESH_DAYS = 30;
export const FRESH_MS = FRESH_DAYS * 86_400_000;
