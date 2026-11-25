/**
 * Target titles, read out of the resume instead of typed by hand.
 *
 * Ported from titles.mjs so the PANEL can do this, not only a workflow I
 * run by hand. A new user uploading a resume got no target titles at all,
 * which means discovery has nothing to match against and the queue stays
 * empty — the one thing that has to work without anyone being told.
 *
 * The single biggest cause of lost volume is the target-title list: 923 of
 * 3029 discovered postings were rejected as "title not relevant to targets",
 * more than distance, salary and the exclude list combined. A person writes
 * four or five titles — the jobs they can picture — and the search then
 * cannot see anything else they are qualified for.
 *
 * So this reads what the resume actually contains and expands it. A cashier
 * has done inventory, scheduling and customer escalation; someone who has
 * run a business has done hiring, payroll, vendor management and sales; a
 * person who writes code is a candidate for analyst and engineering roles
 * whatever their last job title was. None of that is visible from the job
 * titles alone, which is exactly why asking a person to list their targets
 * undershoots.
 *
 * Deterministic by default. The model widens it where a key is available,
 * but a feature that only works while a quota lasts is not a feature, and
 * this one governs how many applications are possible at all.
 */

// Seniority prefixes worth trying, by how much experience the resume shows.
// "Head of" and "Director of" take a FUNCTION — Head of Operations — and
// produce nonsense on a role noun: "Director of Teller", "Head of Technical
// Account Manager". A first run generated a page of those, so they are gone;
// the prefixes that compose with any role are the ones left.
const LADDER: Record<string, string[]> = {
  entry: ["", "Junior ", "Associate ", "Assistant "],
  mid: ["", "Senior ", "Lead ", "Associate "],
  senior: ["", "Senior ", "Lead ", "Principal ", "Director, "],
};

// "Principal" and "Director," belong on professional and technical roles,
// not on counter and clerical ones.
const SENIOR_OK = /\b(engineer|developer|analyst|architect|consultant|scientist|manager|designer|strategist)\b/i;

/**
 * What the resume demonstrates, as capability rather than job title.
 *
 * Each entry is a signal to look for and the roles that signal qualifies
 * someone for. A title the person has held is only one of those roles; the
 * rest are the ones they cannot see from where they are standing.
 */
const SIGNALS = [
  {
    match: /\b(cashier|point of sale|\bpos\b|register|retail associate|sales floor)\b/i,
    roles: [
      "Cashier", "Retail Associate", "Sales Associate", "Customer Service Representative",
      "Front Desk Associate", "Teller", "Client Services Associate", "Store Associate",
      "Receptionist", "Patient Access Representative", "Call Center Representative",
      "Member Services Representative",
    ],
  },
  {
    match: /\b(manager|managed|supervis|team lead|shift lead|led a team|direct reports)\b/i,
    roles: [
      "General Manager", "Operations Manager", "Store Manager", "Assistant Manager",
      "Shift Supervisor", "Team Lead", "Department Manager", "Branch Manager",
      "Office Manager", "Site Supervisor", "Operations Supervisor", "Program Manager",
      "Project Manager", "Customer Success Manager", "Warehouse Supervisor",
    ],
  },
  {
    match: /\b(owner|founder|self[- ]employed|proprietor|entrepreneur|ran (my|a) (own )?business)\b/i,
    roles: [
      "Business Development Manager", "Operations Manager", "General Manager",
      "Account Executive", "Account Manager", "Sales Manager", "Partnerships Manager",
      "Business Analyst", "Vendor Manager", "Procurement Specialist", "Category Manager",
      "Franchise Manager", "Territory Manager", "Client Relationship Manager",
      "Business Operations Analyst", "Strategy Analyst",
    ],
  },
  {
    match: /\b(code|coding|programm|software|developer|engineer|python|javascript|typescript|java\b|sql|react|node)\b/i,
    roles: [
      "Software Engineer", "Software Developer", "Frontend Developer", "Backend Developer",
      "Full Stack Developer", "Data Analyst", "Data Engineer", "Business Intelligence Analyst",
      "Analytics Engineer", "QA Engineer", "Automation Engineer", "Solutions Engineer",
      "Technical Support Engineer", "Implementation Consultant", "Systems Analyst",
      "Application Support Analyst", "Database Administrator", "DevOps Engineer",
      "Technical Account Manager", "Sales Engineer",
    ],
  },
  {
    match: /\b(social media|marketing|content|seo|campaign|brand|copywrit|instagram|tiktok)\b/i,
    roles: [
      "Social Media Manager", "Marketing Coordinator", "Marketing Specialist",
      "Content Strategist", "Content Manager", "Digital Marketing Specialist",
      "Communications Specialist", "Brand Manager", "Community Manager",
      "Email Marketing Specialist", "SEO Specialist", "Growth Marketing Manager",
      "Marketing Analyst", "Copywriter", "Campaign Manager",
    ],
  },
  {
    match: /\b(financ|account|bookkeep|payroll|invoice|budget|p&l|quickbooks|reconcil)\b/i,
    roles: [
      "Financial Analyst", "Accounting Clerk", "Staff Accountant", "Bookkeeper",
      "Accounts Payable Specialist", "Accounts Receivable Specialist", "Payroll Specialist",
      "Billing Specialist", "Budget Analyst", "Credit Analyst", "Finance Manager",
      "Revenue Analyst", "Cost Analyst", "Treasury Analyst", "Audit Associate",
    ],
  },
  {
    match: /\b(customer|client|support|help desk|service desk|escalation|ticket)\b/i,
    roles: [
      "Customer Support Specialist", "Client Success Manager", "Help Desk Technician",
      "Technical Support Specialist", "Service Desk Analyst", "Customer Experience Manager",
      "Support Operations Analyst", "Onboarding Specialist", "Account Coordinator",
    ],
  },
  {
    match: /\b(inventory|warehouse|logistic|supply chain|shipping|receiving|fulfillment)\b/i,
    roles: [
      "Inventory Specialist", "Logistics Coordinator", "Supply Chain Analyst",
      "Warehouse Supervisor", "Fulfillment Manager", "Distribution Coordinator",
      "Procurement Coordinator", "Demand Planner", "Operations Analyst",
      "Transportation Coordinator",
    ],
  },
  {
    match: /\b(train|coach|mentor|onboard|taught|instruct|curriculum)\b/i,
    roles: [
      "Training Specialist", "Learning and Development Coordinator", "Corporate Trainer",
      "Onboarding Specialist", "Instructional Designer", "Enablement Manager",
      "Training Coordinator",
    ],
  },
  {
    match: /\b(schedul|roster|staffing|hiring|recruit|interview|hr\b|human resources)\b/i,
    roles: [
      "Recruiting Coordinator", "Talent Acquisition Specialist", "HR Coordinator",
      "HR Generalist", "Workforce Planner", "Scheduling Coordinator", "Staffing Specialist",
      "People Operations Associate",
    ],
  },
  {
    match: /\b(data|excel|spreadsheet|report|dashboard|analytics|kpi|metrics)\b/i,
    roles: [
      "Data Analyst", "Reporting Analyst", "Operations Analyst", "Business Analyst",
      "Insights Analyst", "Research Analyst", "Performance Analyst", "Data Coordinator",
    ],
  },
  {
    match: /\b(sales|quota|pipeline|prospect|closed deals|upsell|b2b)\b/i,
    roles: [
      "Account Executive", "Sales Representative", "Business Development Representative",
      "Inside Sales Representative", "Sales Coordinator", "Territory Manager",
      "Key Account Manager", "Sales Operations Analyst",
    ],
  },
  {
    match: /\b(admin|administrat|clerical|filing|data entry|office)\b/i,
    roles: [
      "Administrative Assistant", "Executive Assistant", "Office Coordinator",
      "Data Entry Specialist", "Operations Coordinator", "Program Coordinator",
      "Records Clerk", "Project Coordinator",
    ],
  },
];

// Never suggested, whatever the resume says. These are the listings that
// waste an applicant's time or cost them money, and a wider net is exactly
// how someone ends up in one.
const NEVER = [
  /pyramid/i, /\bmlm\b/i, /multi[- ]level/i, /commission[- ]only/i, /100% commission/i,
  /unpaid/i, /volunteer/i, /\bintern(ship)?\b/i, /franchise owner/i, /own your own business/i,
  /distributor/i, /independent contractor opportunity/i, /work from home opportunity/i,
  /be your own boss/i, /recruiter? trainee/i, /door[- ]to[- ]door/i,
];

/** How senior the resume reads, which decides the prefixes worth trying. */
function seniority(resume: string): "entry" | "mid" | "senior" {
  const text = String(resume ?? "");
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const span = years.length >= 2 ? Math.max(...years) - Math.min(...years) : 0;
  const leads = /\b(director|head of|vp\b|vice president|principal|owner|founder)\b/i.test(text);
  if (leads || span >= 10) return "senior";
  if (/\b(senior|lead|manager|supervisor)\b/i.test(text) || span >= 4) return "mid";
  return "entry";
}

/**
 * Titles this resume supports, deterministically.
 *
 * Returns far more than a person would write, on purpose: scoring is what
 * decides which are worth applying to, and it can only judge what the search
 * was allowed to find in the first place.
 */
export function suggestTitles({
  resume,
  profile = {},
  exclude = [],
  limit = 160,
  ladder = false,
}: {
  resume: string;
  profile?: any;
  exclude?: string[];
  limit?: number;
  ladder?: boolean;
}): string[] {
  const text = `${resume ?? ""}\n${profile.target_role ?? ""}\n${profile.current_company ?? ""}`;
  if (!text.trim()) return [];

  const level = seniority(text);
  const prefixes = LADDER[level] ?? [""];

  const base = new Set<string>();
  for (const signal of SIGNALS) {
    if (!signal.match.test(text)) continue;
    for (const role of signal.roles) base.add(role);
  }

  // What they already call themselves belongs in the list too.
  if (profile.target_role) base.add(String(profile.target_role).trim());

  // The seniority variants are off by default, because they match nothing
  // the base role does not.
  //
  // The filter keeps a posting when half the words of any target title
  // appear in it, so "Data Analyst" already matches Senior Data Analyst,
  // Lead Data Analyst and Data Analyst II. Adding those variants quadrupled
  // the list for no extra coverage — and 178 titles took discovery past its
  // host's time limit, which is a real cost for no benefit at all.
  const out = new Set<string>();
  for (const role of base) {
    for (const prefix of ladder ? prefixes : [""]) {
      const title = `${prefix}${role}`.replace(/\s+/g, " ").trim();
      // "Senior Senior Analyst" and "Junior Director of X" help nobody.
      if (/^(senior|lead|junior|associate|assistant|head of|director of|principal)\s+(senior|lead|junior|associate|assistant|head|director|principal)\b/i.test(title)) {
        continue;
      }
      if (/^(junior|assistant|associate)\s+(principal|director)/i.test(title)) continue;
      if (/^(principal|director,)\s/i.test(title) && !SENIOR_OK.test(role)) continue;
      out.add(title);
    }
  }

  const blocked = [...NEVER, ...exclude.map((e) => new RegExp(escapeRe(String(e)), "i"))];
  return [...out]
    .filter((t) => !blocked.some((re) => re.test(t)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

