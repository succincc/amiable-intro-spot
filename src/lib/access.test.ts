import { describe, expect, it } from "vitest";

import { signupProblem, standingMessage } from "@/lib/access";

describe("asking to come in", () => {
  const ok = { fullName: "Pat Example", email: "pat@example.com", password: "long-enough", confirm: "long-enough" };
  it("takes a form that is in order", () => expect(signupProblem(ok)).toBeNull());
  it("wants a full name, a real address, a password of some length, typed the same twice", () => {
    expect(signupProblem({ ...ok, fullName: "Pat" })).toMatch(/first and last/);
    expect(signupProblem({ ...ok, email: "pat@" })).toMatch(/valid email/);
    expect(signupProblem({ ...ok, password: "short", confirm: "short" })).toMatch(/8 characters/);
    expect(signupProblem({ ...ok, confirm: "different-one" })).toMatch(/do not match/);
  });
  it("says where a request stands", () => {
    expect(standingMessage("pending")).toBe("Sign-up request sent. Approval is decided by the owner.");
    expect(standingMessage("denied")).toMatch(/not approved/);
  });
});
