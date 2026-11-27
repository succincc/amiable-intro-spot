// ============================================================================
// roles.ts — the jobs a person has held, read off their resume.
//
// The experience bank is what a resume is rebuilt from for each posting, and
// what the forms' "work history" sections are filled from. Asking someone to
// type it again, having just uploaded it, is asking them to do the system's
// work. This reads it: each stretch of dates under the experience heading is
// a job, with the title, employer and place beside it and the lines under it.
//
// Resumes are laid out a hundred ways, so this reads what it can tell apart
// and leaves the rest: a job is only kept when it has a title or an employer
// and its dates. Pure, so each layout it knows has a test.
// ============================================================================

export type Role = { title: string; company: string; location: string | null; start_date: string | null; end_date: string | null; details: string };

const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const POINT = `(?:${MON}\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4})`;
const RANGE = new RegExp(`(${POINT})\\s*(?:-|–|—|to|through)\\s*(present|current|now|${POINT})`, "i");
const HEADING = /^(summary|profile|objective|education|skills?|technical skills|soft skills|certifications?|licenses?|projects?|awards?|volunteer.*|references?|languages?|interests?|activities|publications?|core competencies|additional information)\b[\s:]*$/i;
const WORK = /^((work|professional|relevant|employment|career)\s+)?(experience|history|employment)\b[\s:]*$/i;
const BULLET = /^\s*[•●▪◦·\-*–]\s+/;
const TITLE_WORD =
  /\b(manager|associate|owner|operator|lead|leader|specialist|director|assistant|representative|engineer|developer|analyst|coordinator|supervisor|clerk|cashier|intern|consultant|officer|founder|co-?founder|technician|agent|server|driver|sales|marketing|marketer|administrator|executive|strategist|designer|writer|editor|teacher|tutor|nurse|aide|attendant|host|bartender|barista|cook|chef|mechanic|installer|recruiter|buyer|planner|accountant|bookkeeper|receptionist|president|head|partner|advisor|adviser|counselor|instructor|trainer|stocker|merchandiser|teller|banker|paralegal|dispatcher|guard|laborer|foreman|estimator|freelance\w*|contractor|volunteer)\b/i;
const PLACE = /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b\.?$|^(remote|hybrid)$/i;

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s|,·•–—-]+|[\s|,·•–—-]+$/g, "").trim();

/** The pieces of a heading line: what sits either side of a bar, a dash, or a wide gap. */
function pieces(line: string): string[] {
  return line
    .split(/\s*\|\s*|\s+[–—-]\s+|\s{3,}|\s+@\s+|\s+at\s+(?=[A-Z])/)
    .flatMap((p) => (PLACE.test(tidy(p)) ? [p] : p.split(/,\s+(?=[A-Z][a-z])/).length === 2 && PLACE.test(tidy(p.split(/,\s+/).slice(-2).join(", "))) ? [p] : [p]))
    .map(tidy)
    .filter((p) => p.length > 1 && p.length < 90);
}

/** The jobs on a resume, most recent first as the resume has them. */
export function rolesFrom(resume: string | null | undefined, max = 12): Role[] {
  const lines = String(resume ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\t/g, "   ").trimEnd());
  // The experience section, where there is a heading for it; the whole text otherwise.
  let from = lines.findIndex((l) => WORK.test(l.trim()));
  let to = lines.length;
  if (from >= 0) {
    const next = lines.findIndex((l, i) => i > from && HEADING.test(l.trim()));
    if (next > 0) to = next;
    from += 1;
  } else {
    from = 0;
    const edu = lines.findIndex((l) => /^education\b[\s:]*$/i.test(l.trim()));
    if (edu > 0) to = edu;
  }
  const body = lines.slice(from, to);
  const starts: number[] = [];
  body.forEach((l, i) => {
    if (!BULLET.test(l) && RANGE.test(l) && l.trim().length < 140) starts.push(i);
  });

  const roles: Role[] = [];
  for (let k = 0; k < starts.length && roles.length < max; k++) {
    const i = starts[k]!;
    const m = body[i]!.match(RANGE)!;
    const here = tidy(body[i]!.replace(m[0], " "));
    // The line above belongs to this job when it is not a bullet, not blank,
    // and not the end of the job before.
    const above = i > 0 ? body[i - 1]!.trim() : "";
    const prevEnd = k > 0 ? starts[k - 1]! : -1;
    const head = above && !BULLET.test(above) && i - 1 > prevEnd && above.length < 120 && !RANGE.test(above) ? above : "";
    // Or the line below, where the dates come first.
    const below = !head && !here && body[i + 1] && !BULLET.test(body[i + 1]!) ? body[i + 1]!.trim() : "";
    const parts = [...pieces(head), ...pieces(here), ...pieces(below)];
    if (!parts.length) continue;

    const location = parts.find((p) => PLACE.test(p)) ?? null;
    const rest = parts.filter((p) => p !== location);
    let title = rest.find((p) => TITLE_WORD.test(p)) ?? "";
    let company = rest.find((p) => p !== title) ?? "";
    if (!title && rest.length >= 2) [title, company] = [rest[0]!, rest[1]!];
    if (!title && !company) continue;

    const until = k + 1 < starts.length ? starts[k + 1]! - (body[starts[k + 1]! - 1] && !BULLET.test(body[starts[k + 1]! - 1]!) && body[starts[k + 1]! - 1]!.trim() ? 1 : 0) : body.length;
    const details = body
      .slice(i + 1 + (below ? 1 : 0), until)
      .map((l) => l.trim())
      .filter((l) => l && !/^[•●▪◦·\-*–]$/.test(l))
      .map((l) => (BULLET.test(l) ? `• ${l.replace(BULLET, "").trim()}` : l))
      .join("\n")
      .slice(0, 4000);
    roles.push({
      title: title || "(title not read)",
      company: company || "(employer not read)",
      location,
      start_date: m[1]!.trim(),
      end_date: /present|current|now/i.test(m[2]!) ? "Present" : m[2]!.trim(),
      details,
    });
  }
  return roles;
}
