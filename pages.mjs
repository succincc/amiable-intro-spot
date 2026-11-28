/**
 * Every row a question has, not the first thousand.
 *
 * The database answers with a thousand rows at most, whatever number is
 * asked for: "limit=50000" is a thousand. Nothing said so, and for as long
 * as every list was short nothing showed it. Then the list of employers
 * passed a thousand, and the check for "is this employer already on file"
 * was reading the oldest thousand of 2,746 and calling the rest new; the
 * count of a queue stopped at exactly 1000; and a reading of the mailbox
 * saw the newest thousand letters and none before them.
 *
 * This asks a thousand at a time until a short page comes back.
 *
 * @param db    the caller's own way of asking: (path) => rows
 * @param path  the question, without limit or offset. Rows come in the
 *              order it names, or by id where it names none.
 * @param max   the most rows worth having
 */
export async function allRows(db, path, max = 60000) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  const order = /[?&]order=/.test(path) ? "" : "order=id.asc&";
  for (let from = 0; from < max; from += 1000) {
    const rows = (await db(`${path}${sep}${order}offset=${from}&limit=1000`)) ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out.length > max ? out.slice(0, max) : out;
}
