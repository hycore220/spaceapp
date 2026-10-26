// @vitest-environment node
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";

it("permits only same-origin demo workers while retaining the offline demo restrictions", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const declaration = server.match(/const demoWorkspaceContentSecurityPolicy = \[([\s\S]*?)\]\.join/);
  expect(declaration).not.toBeNull();
  const directives = [...declaration![1]!.matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
  expect(directives.filter(value => value!.startsWith("worker-src"))).toEqual(["worker-src 'self'"]);
  expect(directives).toEqual(expect.arrayContaining([
    "default-src 'self'", "script-src 'self'", "connect-src 'none'", "frame-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "media-src 'none'"
  ]));
});
