/**
 * Where an employer on file came from, as its record says.
 *
 * "map: 3 place(s) in reach" — found on the map near somebody. "feed: near
 * home" — named by a feed asked about a person's own town. "index: …",
 * "crawl: …" — from a list of large companies, or the web archive: from
 * anywhere. The words stand at the start of the note when the employer is
 * added and are carried to the end of it when the resolver writes what it
 * found, so the worth of each way of finding employers can be counted.
 *
 * Kept apart from the resolver so that it can be checked without a browser.
 */
export function originOf(note) {
  return (String(note ?? "").match(/(?:^|; )((?:map|feed|index|crawl|seed): [^;]{0,60})/) ?? [])[1]?.trim() ?? null;
}
