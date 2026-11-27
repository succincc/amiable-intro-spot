// The questions whose answer has one home: the profile.

/**
 * What the profile itself says to a question, however the form words it: the
 * owner's links, and their citizenship in each of the shapes it is asked in.
 * These are facts with one home, so where the profile changes the saved
 * answer changes with it. Null where the profile does not settle it.
 */
export function fromProfile(q, p) {
  const l = String(q ?? "").toLowerCase();
  const link = (v) => (/^https?:\/\/\S+\.\S+/i.test(String(v ?? "").trim()) ? String(v).trim() : null);
  if (/linked ?in/.test(l) && !/hear about|source|how did you/.test(l)) return link(p.linkedin_url);
  if (/git ?hub/.test(l)) return link(p.github_url);
  if (/\b(portfolio|personal (web)?site|personal url|your website|website url)\b/.test(l)) return link(p.portfolio_url);
  const c = String(p.citizenship ?? "").trim();
  if (c && /\bcitizen/.test(l)) {
    const onlyUS = /^united states only$/i.test(c);
    const us = /^united states/i.test(c);
    // A list of other countries, with "None of the above" at its end.
    if (/which, if any|any of the following|all that apply|any of these/.test(l)) return onlyUS ? "None of the above" : null;
    if (/\b(u\.?s\.?a?\.?|united states|american)\s+citizen|citizen of the (u\.?s\.?a?\.?|united states)/.test(l)) return us ? "Yes" : "No";
    if (/(dual|multiple|more than one|another|other|second)\b[^?]{0,30}citizen/.test(l)) return onlyUS ? "No" : /and another/i.test(c) ? "Yes" : null;
    if (/(country|countries|nation) of citizenship|citizenship (country|status)|what is your citizenship|^citizenship\b|citizen of (which|what) country/.test(l)) return us ? "United States" : null;
  }
  return null;
}
