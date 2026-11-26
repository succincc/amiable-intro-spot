// Which postings are worth measuring at all.
//
// Every reader pulls an employer's whole list and keeps what could be in
// reach: the owner's state, the states that touch it, and anything remote.
// How far each one really is gets measured afterwards; this only keeps a
// posting three time zones away from being saved and measured for nothing.
//
// The state is the owner's, read from the profile when a reader starts. None
// is written here: this file knows the map, not who is on it.

import { STATES } from "./quiet.mjs";

const NAMES = { ...STATES, DC: "District of Columbia" };

/** Each state and the ones it shares a border with. */
export const BORDERS = {
  AL: ["FL", "GA", "MS", "TN"], AK: [], AZ: ["CA", "CO", "NM", "NV", "UT"], AR: ["LA", "MO", "MS", "OK", "TN", "TX"],
  CA: ["AZ", "NV", "OR"], CO: ["AZ", "KS", "NE", "NM", "OK", "UT", "WY"], CT: ["MA", "NY", "RI"], DE: ["MD", "NJ", "PA"],
  DC: ["MD", "VA"], FL: ["AL", "GA"], GA: ["AL", "FL", "NC", "SC", "TN"], HI: [], ID: ["MT", "NV", "OR", "UT", "WA", "WY"],
  IL: ["IA", "IN", "KY", "MO", "WI"], IN: ["IL", "KY", "MI", "OH"], IA: ["IL", "MN", "MO", "NE", "SD", "WI"],
  KS: ["CO", "MO", "NE", "OK"], KY: ["IL", "IN", "MO", "OH", "TN", "VA", "WV"], LA: ["AR", "MS", "TX"], ME: ["NH"],
  MD: ["DC", "DE", "PA", "VA", "WV"], MA: ["CT", "NH", "NY", "RI", "VT"], MI: ["IN", "OH", "WI"], MN: ["IA", "ND", "SD", "WI"],
  MS: ["AL", "AR", "LA", "TN"], MO: ["AR", "IA", "IL", "KS", "KY", "NE", "OK", "TN"], MT: ["ID", "ND", "SD", "WY"],
  NE: ["CO", "IA", "KS", "MO", "SD", "WY"], NV: ["AZ", "CA", "ID", "OR", "UT"], NH: ["MA", "ME", "VT"], NJ: ["DE", "NY", "PA"],
  NM: ["AZ", "CO", "OK", "TX", "UT"], NY: ["CT", "MA", "NJ", "PA", "VT"], NC: ["GA", "SC", "TN", "VA"], ND: ["MN", "MT", "SD"],
  OH: ["IN", "KY", "MI", "PA", "WV"], OK: ["AR", "CO", "KS", "MO", "NM", "TX"], OR: ["CA", "ID", "NV", "WA"],
  PA: ["DE", "MD", "NJ", "NY", "OH", "WV"], RI: ["CT", "MA"], SC: ["GA", "NC"], SD: ["IA", "MN", "MT", "ND", "NE", "WY"],
  TN: ["AL", "AR", "GA", "KY", "MO", "MS", "NC", "VA"], TX: ["AR", "LA", "NM", "OK"], UT: ["AZ", "CO", "ID", "NM", "NV", "WY"],
  VT: ["MA", "NH", "NY"], VA: ["DC", "KY", "MD", "NC", "TN", "WV"], WA: ["ID", "OR"], WV: ["KY", "MD", "OH", "PA", "VA"],
  WI: ["IA", "IL", "MI", "MN"], WY: ["CO", "ID", "MT", "NE", "SD", "UT"],
};

/** "nj", "NJ" or "New Jersey" as "NJ"; null for anything that is not a state. */
export function stateCode(state) {
  const s = String(state ?? "").trim();
  if (!s) return null;
  if (BORDERS[s.toUpperCase()]) return s.toUpperCase();
  const hit = Object.entries(NAMES).find(([, name]) => name.toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : null;
}

/** A state's name written out, as a careers site's own search box wants it. */
export const stateName = (state) => NAMES[stateCode(state)] ?? null;

/**
 * What a posting's place has to look like to be kept: in the state, in one
 * that touches it, or remote. With no state known, everything is kept and
 * the measuring decides.
 */
export function nearPattern(state) {
  const code = stateCode(state);
  if (!code) return /[\s\S]*/;
  const codes = [code, ...BORDERS[code]];
  const names = codes.map((c) => NAMES[c]).filter(Boolean).map((n) => `\\b${n.toLowerCase().replace(/ /g, "\\s+")}\\b`);
  return new RegExp(`,\\s*(${codes.join("|")})\\b|${names.join("|")}|\\bremote\\b|\\bvirtual\\b`, "i");
}
