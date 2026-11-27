// A school's name as a list of schools would hold it.

/**
 * A school's name with nothing tacked on: "X University - Bachelor of Arts"
 * and "X University, Newark (2019)" are both "X University".
 */
export function schoolNameOnly(text) {
  const bits = String(text ?? "")
    .split(/\s+[-–—]\s+|\s*[|•·,(]\s*/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (bits.find((b) => /\b(university|college|institute|polytechnic|school|academy)\b/i.test(b)) ?? bits[0] ?? "").trim();
}

/**
 * Which of the offered lines is this school. Every distinctive word of the
 * name must be on the line; where several lines carry them all, the shortest
 * is the school itself rather than one of its campuses. No match is null: a
 * school is never chosen because it was first on the list.
 */
export function schoolOption(offered, name) {
  const words = String(name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !/^(the|of|and|at|for)$/.test(w));
  if (!words.length) return null;
  const hits = (offered ?? []).filter((o) => {
    const t = ` ${String(o.text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    return words.every((w) => t.includes(` ${w} `));
  });
  return hits.sort((a, b) => String(a.text).length - String(b.text).length)[0] ?? null;
}
