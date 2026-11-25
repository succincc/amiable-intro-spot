// ============================================================================
// classify.ts — sorts the replies, matches them to the job, drafts the answer.
//
// Once applications go out in volume the inbox is the only place the truth
// lives. A hundred applications produce a hundred automated confirmations,
// eighty rejections, and the three emails that actually matter buried among
// them. Finding those three by hand defeats the point of automating the rest.
//
// THE TRAP THIS FILE EXISTS TO AVOID:
//
// The obvious classifier looks for "interview" and calls it an interview.
// But rejections are written like this:
//
//   "After careful review we have decided not to move your application
//    forward to the interview stage."
//
// Keyword matching files that as good news. That is the worst error this
// system can make — not because it loses information, but because the panel
// then tells you that you have an interview you do not have. So rejection is
// tested FIRST, and every later rule assumes rejection has been ruled out.
// ============================================================================

export type Category =
  "rejection" | "interview" | "offer" | "action_needed" | "confirmation" | "other";

export type Classified = {
  category: Category;
  confidence: "high" | "low";
  why: string; // which rule fired, so a wrong call is auditable
};

const re = (...parts: string[]) => new RegExp(parts.join("|"), "i");

// Boilerplate that makes everything after it hypothetical. The standard
// application receipt ends:
//
//   "If your qualifications match our needs, we will contact you to
//    schedule an interview."
//
// Read as a whole, that sentence promises an interview. It is a receipt. So
// the interview and offer rules are tested only against sentences that are
// not framed this way — and the markers are deliberately about SELECTION
// rather than any "if", because "if you are available Thursday, let's
// schedule a call" is a real interview request.
const HYPOTHETICAL = re(
  "\\bif (?:you|your)\\b.{0,70}\\b(?:selected|shortlisted|chosen|qualif|match(?:es)?|a (?:good )?fit|move forward|advance|under consideration|progress)",
  "\\bif your (?:application|r.sum.|resume|background|experience|skills|profile|candidacy)\\b",
  "\\bshould (?:you|your|we)\\b.{0,70}\\b(?:selected|qualif|match|progress|advance|decide)",
  "\\bif (?:we|there) (?:determine|decide|believe|is|are)\\b",
  "\\bif we\\b.{0,40}\\b(?:extend|offer|hire|select|proceed|move forward)\\b",
  "\\bin the event (?:that )?(?:you|we)\\b",
  "\\bmay be (?:contacted|invited|asked)\\b",
  "\\bcandidates (?:who|that) (?:are|match)\\b",
);

/**
 * The message with hypothetical sentences removed.
 *
 * Splitting on sentence boundaries rather than stripping phrases keeps a real
 * request intact when it happens to sit next to boilerplate — a recruiter who
 * writes a genuine invitation above a legal footer should still be read as
 * one.
 */
function literalText(text: string): string {
  // Plain-text mail wraps at about 72 columns, so a single newline usually
  // falls mid-sentence. Treating it as a sentence boundary split
  //
  //     "If your qualifications match our needs, we will contact you to
  //      schedule an interview."
  //
  // into two, and the orphaned second half — "schedule an interview." — read
  // as a genuine invitation. That filed receipts as interviews, which is the
  // precise error this whole file is built to avoid. Soft wraps are joined
  // first; a blank line still separates paragraphs.
  const unwrapped = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/([^\n.!?])[ \t]*\n[ \t]*(?=[^\n])/g, "$1 ");

  return unwrapped
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !HYPOTHETICAL.test(sentence))
    .join(" ");
}

/**
 * Words that mark a message as being about hiring at all.
 *
 * Several action_needed patterns describe urgency rather than recruiting —
 * "expires in 3 days", "submit a claim form" — and every promotion and legal
 * notice in a real inbox trips them. Gating those on recruiting language
 * keeps a 48-hour assessment flagged while a Black Friday countdown is not.
 */
const RECRUITING = re(
  "\\b(?:applicat(?:ion|ions)|applied|applicant|candidate|candidacy|recruit(?:er|ers|ing|ment)?|hiring|interview|r.sum.|resume|job|position|req(?:uisition)?|talent acquisition|onboarding|offer letter)\\b",
);

// Checked in this order. Order is the whole design.
//
// `decisive` marks a rule trustworthy enough to settle the matter from the
// subject line alone. Confirmation is NOT one of them, because "Thank you for
// your interest in Target" is the standard subject on both a receipt and a
// rejection. Deciding from that subject files rejections as confirmations —
// which hides the bad news and inflates the confirmation count that is
// supposed to be the audit trail. So confirmation is only ever reached after
// the body has been read.
// `literalOnly` marks a rule that must not fire inside a hypothetical
// sentence — see HYPOTHETICAL above.
// `requires` is a second regex the whole message must also satisfy, for rules
// whose own patterns are not specific to hiring.
const RULES: Array<{
  cat: Category;
  why: string;
  decisive: boolean;
  literalOnly?: boolean;
  requires?: RegExp;
  test: RegExp;
}> = [
  // --- 1. REJECTION, before anything else ---------------------------------
  // These phrases are near-universal in ATS rejection templates and do not
  // appear in good news. "move forward with other candidates" is the single
  // most common sentence in American hiring.
  {
    cat: "rejection",
    decisive: true,
    why: "rejection phrasing",
    test: re(
      "\\bwe (?:have |will )?(?:decided|elected|chosen) (?:not|to not)\\b",
      "\\bnot (?:to )?(?:move|moving|proceed|progress)(?:ing)? (?:you|your|forward)\\b",
      "\\b(?:move|moving|proceed|proceeding) forward with other\\b",
      "\\bpursu(?:e|ing) other (?:candidates|applicants)\\b",
      "\\bselected another candidate\\b",
      "\\bwill not be (?:moving|proceeding|progressing|advancing)\\b",
      "\\bunable to (?:offer|move|proceed|progress)\\b",
      "\\bno longer under consideration\\b",
      "\\byour application (?:was|has been) (?:unsuccessful|declined|rejected)\\b",
      "\\bnot (?:be )?(?:a |the )?(?:right|best) (?:fit|match) (?:at this time|for this)\\b",
      "\\b(?:position|role|req|requisition) (?:has been |was )?(?:closed|filled|cancell?ed)\\b",
      "\\bdecided to (?:go|proceed) (?:in a different direction|with another)\\b",
      "\\bwe (?:regret|are sorry) to (?:inform|share|let you know)\\b",
      "\\bkeep your (?:resume|r.sum.|application|details) on file\\b",
    ),
  },

  // --- 2. OFFER -----------------------------------------------------------
  {
    cat: "offer",
    decisive: true,
    literalOnly: true,
    why: "offer language",
    test: re(
      "\\b(?:offer of|offer for) (?:employment|the position)\\b",
      "\\bpleased to (?:offer|extend)\\b",
      "\\bformal offer\\b",
      "\\boffer letter\\b",
      "\\bextend(?:ing)? (?:you )?an offer\\b",
      "\\bwelcome (?:you )?(?:to|aboard)\\b.{0,40}\\bteam\\b",
      "\\bcontingent offer\\b",
    ),
  },

  // --- 3. INTERVIEW -------------------------------------------------------
  // Only reached once rejection is ruled out, so a bare "interview" is safe
  // here — but these still require a scheduling or advancement verb, because
  // confirmations say "if selected for an interview we will contact you".
  {
    cat: "interview",
    decisive: true,
    literalOnly: true,
    why: "interview or scheduling request",
    test: re(
      "\\b(?:schedule|scheduling|set up|arrange|book) (?:a |an |some )?(?:time|call|chat|meeting|interview|conversation|screen)\\b",
      "\\b(?:invite|inviting|invitation) (?:you )?to\\b.{0,30}\\b(?:interview|call|chat|conversation|screen)\\b",
      "\\b(?:would|'d) (?:like|love) to (?:speak|talk|chat|meet|connect)\\b",
      "\\bavailability (?:for|to)\\b.{0,30}\\b(?:call|interview|chat|meeting|screen)\\b",
      "\\b(?:are you|would you be) available\\b",
      "\\b(?:move|moving|advance|advancing|progress|progressing) (?:you |your |to )?(?:forward |on )?to the (?:next|interview|first)\\b",
      "\\bnext (?:step|steps|stage|round)\\b",
      "\\bphone screen\\b",
      "\\bhiring manager would like\\b",
      "\\bpick a time\\b",
      "\\b(?:calendly|book(?:ings)?\\.|greenhouse\\.io/guides|savvycal|cal\\.com)\\b",
    ),
  },

  // --- 4. ACTION NEEDED ---------------------------------------------------
  // Assessments, forms, verification. These have deadlines, which is why they
  // outrank confirmation: a confirmation can wait, a 48-hour assessment
  // cannot.
  {
    cat: "action_needed",
    decisive: true,
    why: "something is required of you",
    test: re(
      "\\b(?:complete|finish|take) (?:the |your |a |an )?(?:assessment|test|questionnaire|survey|exercise|challenge|screening)\\b",
      "\\b(?:hackerrank|codility|codesignal|hirevue|hirevue|karat|woven|coderbyte|predictive index|wonderlic)\\b",
      "\\b(?:video|one-way) interview\\b",
      // Kept ungated because it is load-bearing: this is the mail a portal
      // sends before a new account works, and the Workday registration flow
      // depends on it being seen.
      "\\b(?:verify|confirm) your (?:email|identity|account)\\b",
    ),
  },

  // --- 4b. ACTION NEEDED, but only in a hiring message --------------------
  // These describe urgency, not recruiting. On their own they fire on every
  // promotion, prize draw and class-action notice in a real inbox — which is
  // exactly what happened on the first live sync: a Lyft credits offer, a
  // Microsoft Rewards mail and a drug settlement were all filed as things
  // the user had to act on. RECRUITING is the gate that separates a 48-hour
  // assessment from a Black Friday countdown.
  {
    cat: "action_needed",
    decisive: true,
    why: "a hiring message with a deadline",
    requires: RECRUITING,
    test: re(
      "\\baction (?:is )?required\\b",
      // Every service on earth sends this. "Your account was used on a new
      // device" is a security notice, not something a job search must act on.
      "\\breset your password\\b",
      "\\b(?:additional|more) information (?:is )?(?:needed|required|requested)\\b",
      "\\b(?:please )?(?:fill out|complete|submit)\\b.{0,30}\\b(?:form|paperwork|documents?)\\b",
      "\\bwithin (?:the next )?\\d+ (?:hours|days|business days)\\b",
      "\\bexpires?\\b.{0,20}\\b(?:hours|days)\\b",
    ),
  },

  // --- 5. CONFIRMATION ----------------------------------------------------
  // Receipts. Individually worthless, collectively the audit trail: if the
  // applier claims 40 sent and 12 confirmations arrive, that gap is the most
  // important number in the system.
  {
    cat: "confirmation",
    decisive: false,
    why: "application receipt",
    test: re(
      "\\b(?:thank you|thanks) for (?:your )?(?:applying|application|your interest|submitting)\\b",
      "\\b(?:we|application) (?:have |has )?(?:received|got)\\b.{0,30}\\bapplication\\b",
      "\\byour application (?:was|has been|is) (?:received|submitted|complete)\\b",
      "\\bapplication (?:received|submitted|confirmation)\\b",
      "\\bwe('ve| have) got your application\\b",
      "\\bsuccessfully (?:applied|submitted)\\b",
      "\\bif (?:your|you)\\b.{0,40}\\b(?:match|selected|shortlisted)\\b.{0,40}\\bwe will\\b",
    ),
  },
];

/**
 * Classify one email from its subject and body.
 *
 * Returns low confidence with category "other" when nothing fires — the
 * caller can then spend a model call on it. Rules handle the overwhelming
 * majority, which keeps the free AI quota for the work that needs judgement.
 */
export function classifyEmail(subject?: string | null, body?: string | null): Classified {
  // Subject lines are written to be classified and carry far less noise than
  // bodies (which end in legal boilerplate and unsubscribe links), so weight
  // the subject by scanning it first with the same rules.
  const subj = (subject || "").slice(0, 500);
  const text = `${subj}\n${(body || "").slice(0, 6000)}`;
  const literal = literalText(text);
  const literalSubj = literalText(subj);
  const against = (rule: { literalOnly?: boolean }, full: string, lit: string) =>
    rule.literalOnly ? lit : full;
  // A gated rule is tested against the whole message even in the subject
  // pass: "Action required" is a subject line, and whether it is about
  // hiring is only ever said in the body.
  const gateOpen = (rule: { requires?: RegExp }) => !rule.requires || rule.requires.test(text);

  // 1. A decisive rule in the subject line settles it.
  for (const rule of RULES) {
    if (rule.decisive && gateOpen(rule) && rule.test.test(against(rule, subj, literalSubj))) {
      return { category: rule.cat, confidence: "high", why: `${rule.why} (subject)` };
    }
  }
  // 2. A decisive rule anywhere in the message settles it. This runs before
  //    any weak rule so that a rejection body always beats a receipt-shaped
  //    subject line.
  for (const rule of RULES) {
    if (rule.decisive && gateOpen(rule) && rule.test.test(against(rule, text, literal))) {
      return { category: rule.cat, confidence: "high", why: rule.why };
    }
  }
  // 3. Only now the weak rules.
  for (const rule of RULES) {
    if (gateOpen(rule) && rule.test.test(against(rule, text, literal))) {
      return { category: rule.cat, confidence: "high", why: rule.why };
    }
  }
  return { category: "other", confidence: "low", why: "no rule matched" };
}

// ---------------------------------------------------------------------------
// Matching an email to the job it is about
// ---------------------------------------------------------------------------

// Words that carry no identity. A company name is only useful for matching
// once these are gone — "Performance Marketing Agentur firststars GmbH"
// reduces to "firststars", which is the only part of it that could ever
// identify a sender.
//
// This list is why a real inbox matched four pieces of promotional mail to
// that employer: "marketing" survived as a token, so any footer reading "you
// received this marketing email" scored a match. Generic business and
// non-English corporate forms are dropped for the same reason.
const CORP_NOISE =
  /\b(inc|llc|ltd|limited|corp|corporation|company|co|group|holdings|plc|llp|the|and|of|usa|us|global|international|services|solutions|systems|technologies|partners|gmbh|mbh|agentur|ag|kgaa|sarl|bvba|holding|marketing|performance|media|digital|agency|consulting|consultants|staffing|recruiting|recruitment|talent|careers?|jobs|enterprises|industries|associates|worldwide|national|ventures|labs|studio|brands|team|people)\b/g;

// Free webmail. An employer writes from its own domain or its ATS; mail from
// one of these is a person, which for a receipt means a person who is not the
// employer.
const WEBMAIL =
  /^(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|zoho|yandex|fastmail|hey)\.[a-z.]+$/;

/** Distinctive lowercase tokens from a company name. */
function nameTokens(company?: string | null): string[] {
  if (!company) return [];
  return company
    .toLowerCase()
    .replace(CORP_NOISE, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

export type JobRef = { id: string; company?: string | null; title?: string | null };

/**
 * Work out which application an email is a reply to.
 *
 * Deliberately conservative. A wrong match attaches a rejection to the wrong
 * job and corrupts the only honest record of what is happening, so when the
 * evidence is thin this returns null and the email stays unattached — which
 * is visibly incomplete rather than quietly wrong.
 */
export function matchJob(
  email: { from_addr?: string | null; subject?: string | null; body?: string | null },
  jobs: JobRef[],
): string | null {
  const from = (email.from_addr || "").toLowerCase();
  const domain = from.split("@")[1] || "";

  // A job alert is not a reply to an application. Aggregators mail digests
  // of openings that name employers in bulk, which is exactly the shape that
  // scores a match while meaning nothing — a ZipRecruiter alert about a State
  // Farm agency matched an unrelated application on one shared word.
  if (
    /(?:^|\.)(?:ziprecruiter|indeed|linkedin|glassdoor|monster|dice|simplyhired|careerbuilder|jooble|talent|adzuna|lensa)\.[a-z.]+$/.test(
      domain,
    ) ||
    /\b(?:job alert|new jobs?(?: for you)?|jobs? you might|recommended (?:jobs?|for you)|job digest|similar jobs)\b/i.test(
      email.subject || "",
    )
  ) {
    return null;
  }
  // Strip the public suffix and any ATS host, leaving the brand: a mail from
  // "no-reply@target.greenhouse-mail.io" should still read as "target".
  const domainWords = domain
    .replace(/\.(com|org|net|io|co|us|jobs|careers)(\.[a-z]{2})?$/, "")
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w.length >= 4 &&
        !/^(mail|smtp|email|notification|no|reply|noreply|greenhouse|lever|workday|myworkday|icims|taleo|smartrecruiters|ashby|workable|jobvite|bamboohr)$/.test(
          w,
        ),
    );

  const haystack = `${email.subject || ""}\n${(email.body || "").slice(0, 4000)}`.toLowerCase();

  let best: { id: string; score: number } | null = null;

  for (const job of jobs) {
    const tokens = nameTokens(job.company);
    if (!tokens.length) continue;

    let score = 0;
    // Sender domain carrying the company name is the strongest signal there
    // is — an automated mail from the employer's own domain.
    if (tokens.some((t) => domainWords.some((d) => d.includes(t) || t.includes(d)))) score += 10;
    // Company named in the subject or body.
    if (tokens.some((t) => haystack.includes(t))) score += 4;
    // Exact job title present. Only meaningful alongside the company, which
    // the threshold below enforces — titles like "Analyst" are everywhere.
    const title = (job.title || "").toLowerCase();
    if (title.length >= 10 && haystack.includes(title)) score += 4;

    if (score > 0 && (!best || score > best.score)) best = { id: job.id, score };
  }

  if (!best) return null;

  // 4 is "company named somewhere", which is enough when a company or its
  // ATS is doing the writing. It is not enough from a free webmail address.
  //
  // Employers answer from their own domain or their ATS. A gmail.com sender
  // naming a company once in a body is exactly the thin evidence this
  // function exists to refuse — and refusing matters here more than
  // anywhere, because a matched email can move a job to "interview" through
  // sync_job_from_email(). A message sent by hand to test the inbox did
  // precisely that to a real Ramp application. So webmail has to clear a
  // higher bar: the company AND the exact job title, not one mention.
  const threshold = WEBMAIL.test(domain) ? 8 : 4;
  return best.score >= threshold ? best.id : null;
}

// ---------------------------------------------------------------------------
// Replying
// ---------------------------------------------------------------------------

/**
 * Should a reply be sent to this address at all?
 *
 * Automated mail comes from unmonitored mailboxes. Replying to one is at best
 * ignored and at worst a hard bounce, and bounces cost sender reputation —
 * which is the thing every later email depends on. So this is a hard gate,
 * checked before anything is drafted.
 */
export function isReplyable(fromAddr?: string | null): boolean {
  const a = (fromAddr || "").toLowerCase().trim();
  if (!a.includes("@")) return false;
  const local = a.split("@")[0] ?? "";
  if (
    /(^|[._-])(no-?reply|donotreply|do-not-reply|notifications?|automated|auto|mailer|bounce|postmaster|system|alerts?)([._-]|$)/.test(
      local,
    )
  ) {
    return false;
  }
  if (/^(mailer-daemon|nobody)$/.test(local)) return false;
  return true;
}

/** Which categories are worth answering, and whether a human should see it first. */
export function replyPolicy(category: Category): "auto" | "draft" | "none" {
  switch (category) {
    // A fast, warm reply to a scheduling request measurably helps, and the
    // content is low-risk — you are agreeing to talk.
    case "interview":
      return "auto";
    // Assessments and forms need you to actually do the thing; an auto-reply
    // promising otherwise would be a lie. Acknowledge, but let it be seen.
    case "action_needed":
      return "draft";
    // Never auto-answer an offer. That is a negotiation.
    case "offer":
      return "draft";
    // Replying to a rejection or a receipt is noise.
    case "rejection":
    case "confirmation":
      return "none";
    default:
      return "draft";
  }
}

const REPLY_PROMPT = `Write a short email reply, as the candidate, to the message below.

RULES
- First person, as the candidate. Never mention being an AI.
- Open by thanking them, once, briefly. Then get to the point.
- {INTENT}
- Use ONLY facts from the resume. Invent nothing — no dates, no availability
  you were not given, no employers, no numbers.
- Do not restate your whole background. They have the resume.
- Four to six sentences. No bullet points, no markdown, no subject line, no
  signature block — the signature is added separately.
- No placeholders of any kind. Never write [Name], [Date] or [Company].
- For times, use YOUR AVAILABILITY below exactly as given. Offer it; do not
  add to it, narrow it or turn it into specific dates. If it is empty, say
  you are flexible and ask them to propose a time that suits them.

Return ONLY the body of the reply.

YOUR NAME: {NAME}
YOUR AVAILABILITY: {AVAILABILITY}
COMPANY: {COMPANY}
ROLE: {TITLE}

THEIR EMAIL:
Subject: {SUBJECT}
{BODY}

YOUR RESUME:
{RESUME}`;

const INTENT: Record<Category, string> = {
  interview:
    "Accept the conversation enthusiastically and make scheduling easy. If they offered times, say which work. If not, give a broad window and invite them to pick.",
  action_needed:
    "Confirm you have seen what is required and will complete it promptly. Ask only about a genuine blocker, if the email contains one.",
  offer:
    "Thank them warmly, say you are glad to receive it, and ask for the written details and a reasonable window to review. Do not accept, decline, or discuss numbers.",
  other: "Answer what was actually asked, briefly and helpfully.",
  rejection: "Thank them briefly and ask to be considered for future openings.",
  confirmation: "Acknowledge receipt briefly.",
};

/**
 * A reply to an interview request, written with no model.
 *
 * The model writes these better, and the model is free only up to a daily
 * allowance that is often gone by noon. An interview request that arrives in
 * the afternoon then got no reply at all — the one message this whole system
 * exists to produce, left unanswered because a quota ran out. This says the
 * three things such a reply has to say: yes, when, and how to reach me. All
 * of it is the owner's own: their availability as they wrote it in settings,
 * their name, their phone number.
 *
 * Only for interview requests. An offer or an assessment still waits for a
 * person, model or no model.
 */
export function plainInterviewReply(opts: {
  job?: { company?: string | null; title?: string | null } | null;
  profile: { full_name?: string | null; phone?: string | null; availability?: string | null };
}): string {
  const { job, profile } = opts;
  const role = String(job?.title ?? "").replace(/\s+/g, " ").trim();
  const company = String(job?.company ?? "").replace(/\s+/g, " ").trim();
  const about = role ? `the ${role} role${company ? ` at ${company}` : ""}` : company ? `the role at ${company}` : "the role";
  const when = String(profile.availability ?? "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const phone = String(profile.phone ?? "").trim();
  const lines = [
    "Hello,",
    "",
    `Thank you for getting in touch about ${about}. I would be glad to speak with you.`,
    "",
    when
      ? `I am available ${/^(i am|i'm|available)\b/i.test(when) ? when.replace(/^(i am|i'm)\s+(available\s+)?|^available\s+/i, "") : when}. If one of those times suits you, tell me which and I will confirm right away; if not, send me what works on your side and I will make it fit.`
      : "My schedule is flexible, so please send me the times that work on your side and I will confirm right away.",
    ...(phone ? ["", `You can also reach me directly at ${phone}.`] : []),
    "",
    "Thank you,",
    ...[profile.full_name, phone].filter(Boolean).map(String),
  ];
  return lines.join("\n");
}

/**
 * Draft a reply. Returns null when no reply should be sent, so the caller
 * cannot accidentally mail a no-reply address or answer a rejection.
 */
export async function draftReply(opts: {
  email: { from_addr?: string | null; subject?: string | null; body?: string | null };
  category: Category;
  job?: { company?: string | null; title?: string | null } | null;
  profile: { full_name?: string | null; resume_text?: string | null; phone?: string | null; availability?: string | null };
  apiKey: string;
  model?: string;
}): Promise<string | null> {
  const { email, category, job, profile, apiKey } = opts;
  if (replyPolicy(category) === "none") return null;
  if (!isReplyable(email.from_addr)) return null;
  // With no model to ask, an interview request still gets its answer.
  const unaided = () => (category === "interview" && profile.full_name ? plainInterviewReply({ job: job ?? null, profile }) : null);
  if (!apiKey) return unaided();

  const prompt = REPLY_PROMPT.replace("{INTENT}", INTENT[category])
    .replace("{NAME}", profile.full_name || "")
    .replace("{AVAILABILITY}", String(profile.availability ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || "(none given)")
    .replace("{COMPANY}", job?.company || "the company")
    .replace("{TITLE}", job?.title || "the role")
    .replace("{SUBJECT}", email.subject || "")
    .replace("{BODY}", (email.body || "").slice(0, 2500))
    .replace("{RESUME}", (profile.resume_text || "").slice(0, 2500));

  let text: string;
  try {
    const { callGemini } = await import("@/lib/gemini.server");
    text = await callGemini({
      prompt,
      apiKey,
      model: opts.model,
      temperature: 0.5,
      maxTokens: 500,
    });
  } catch (e) {
    // An interview invitation sitting there with no draft looks identical
    // whether the quota ran out, the model was retired or the key is wrong —
    // and only the first is worth waiting out.
    console.warn(`[inbox] the model did not draft a reply: ${String((e as Error)?.message ?? e)}`);
    return unaided();
  }
  if (!text) return unaided();

  const body = text
    .replace(/^(here'?s?|here is|sure[,!]?|certainly[,!]?)[^\n]*\n+/i, "")
    .replace(/^subject:.*\n+/i, "")
    .replace(/\*\*/g, "")
    .trim();

  // A leftover placeholder means the model did not have a fact it needed.
  // Sending "Dear [Hiring Manager]" is worse than sending nothing, and this
  // is the one failure a human reader notices instantly.
  if (/\[[A-Za-z][^\]]{1,30}\]/.test(body)) return unaided();
  if (body.length < 40) return unaided();

  const sig = [profile.full_name, profile.phone].filter(Boolean).join("\n");
  return sig ? `${body}\n\n${sig}` : body;
}
