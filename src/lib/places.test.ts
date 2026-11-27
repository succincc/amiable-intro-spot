import { describe, expect, it } from "vitest";

import { townOnly, townsFrom, zipsFrom } from "@/lib/places";

describe("a town typed, a town chosen", () => {
  it("keeps the town out of 'Town, ST'", () => {
    expect([townOnly("Springfield, NJ"), townOnly("  New   York City , NY"), townOnly("Hazlet")]).toEqual(["Springfield", "New York City", "Hazlet"]);
  });

  it("reads the towns a search offers: this country's, once each, with the state as two letters", () => {
    const towns = townsFrom({ features: [
      { properties: { name: "Springfield", state: "New Jersey", county: "Union County", countrycode: "US", osm_value: "town" } },
      { properties: { name: "Springfield", state: "New Jersey", county: "Union County", countrycode: "US", osm_value: "town" } },
      { properties: { name: "Springfield", state: "Illinois", countrycode: "US", osm_value: "city" } },
      { properties: { name: "Springfield", state: "Ontario", countrycode: "CA", osm_value: "town" } },
      { properties: { name: "Springfield Avenue", state: "New Jersey", countrycode: "US", osm_value: "residential" } },
      { properties: { name: "Somewhere", state: "Not A State", countrycode: "US", osm_value: "town" } },
    ] });
    expect(towns.map((t) => t.label)).toEqual(["Springfield, NJ (Union County)", "Springfield, IL"]);
    expect(towns[0]).toMatchObject({ city: "Springfield", state: "NJ" });
    expect(townsFrom(null)).toEqual([]);
  });

  it("reads a town's postal codes, and only ones that are postal codes", () => {
    expect(zipsFrom({ places: [{ "post code": "07081" }, { "post code": "07081" }, { "post code": "07080" }, { "post code": "n/a" }] })).toEqual(["07080", "07081"]);
    expect(zipsFrom({})).toEqual([]);
  });
});
