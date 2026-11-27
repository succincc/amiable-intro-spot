import { describe, expect, it } from "vitest";

import { forUser, perPerson } from "@/lib/scope.server";

const ME = "22222222-2222-2222-2222-222222222222";

/** A stand-in for the all-seeing client that writes down what it was asked. */
function recorder() {
  const log: string[] = [];
  const chain = (start: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "is", "in", "gte", "order", "limit", "maybeSingle", "select"]) c[m] = (...a: unknown[]) => { log.push(`${m}(${a.map((x) => JSON.stringify(x)).join(",")})`); return c; };
    log.push(start);
    return c;
  };
  const admin = {
    from: (t: string) => ({
      select: (...a: unknown[]) => chain(`${t}.select(${a.map((x) => JSON.stringify(x)).join(",")})`),
      insert: (v: unknown) => chain(`${t}.insert(${JSON.stringify(v)})`),
      upsert: (v: unknown, o?: unknown) => chain(`${t}.upsert(${JSON.stringify(v)},${JSON.stringify(o)})`),
      update: (v: unknown) => chain(`${t}.update(${JSON.stringify(v)})`),
      delete: () => chain(`${t}.delete()`),
    }),
    auth: { admin: { marker: true } },
  };
  return { admin, log };
}

describe("the server working for one person", () => {
  it("limits every read, change and removal to that person", () => {
    const { admin, log } = recorder();
    const sb = forUser(admin, ME);
    sb.from("jobs").select("id").eq("status", "queued");
    sb.from("profile").update({ autopilot: true }).eq("id", 1);
    sb.from("emails").delete().eq("message_id", "m1");
    expect(log).toEqual([
      'jobs.select("id")', `eq("user_id","${ME}")`, 'eq("status","queued")',
      'profile.update({"autopilot":true})', `eq("user_id","${ME}")`, 'eq("id",1)',
      "emails.delete()", `eq("user_id","${ME}")`, 'eq("message_id","m1")',
    ]);
  });

  it("stamps every new row with that person, whatever the row said", () => {
    const { admin, log } = recorder();
    const sb = forUser(admin, ME);
    sb.from("jobs").insert([{ url: "a" }, { url: "b", user_id: "someone-else" }]);
    sb.from("jobs").upsert({ url: "a" }, { onConflict: "url", ignoreDuplicates: true });
    sb.from("call_keys").upsert({ id: 1, voice_key: "k" }, { onConflict: "id" });
    expect(log[0]).toBe(`jobs.insert([{"url":"a","user_id":"${ME}"},{"url":"b","user_id":"${ME}"}])`);
    expect(log[1]).toBe(`jobs.upsert({"url":"a","user_id":"${ME}"},{"onConflict":"user_id,url","ignoreDuplicates":true})`);
    expect(log[2]).toBe(`call_keys.upsert({"id":1,"voice_key":"k","user_id":"${ME}"},{"onConflict":"user_id"})`);
  });

  it("leaves shared tables alone, refuses a view, and refuses to work for nobody", () => {
    const { admin, log } = recorder();
    const sb = forUser(admin, ME);
    sb.from("geo_cache").select("*").eq("place", "x");
    expect(log).toEqual(['geo_cache.select("*")', 'eq("place","x")']);
    expect(() => sb.from("v_inbox")).toThrow(/does not read the view/);
    expect(sb.auth.admin.marker).toBe(true);
    expect(() => forUser(admin, "")).toThrow(/no person/);
    expect(() => forUser(admin, "not-an-id")).toThrow(/no person/);
  });

  it("asks for 'only one' per person", () => {
    expect([perPerson("url"), perPerson("id"), perPerson("ats,token,site"), perPerson("user_id,url"), perPerson(undefined)]).toEqual(["user_id,url", "user_id", "user_id,ats,token,site", "user_id,url", undefined]);
  });
});
