import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimLoginCode } from "../src/cloud/workspace.js";

/** A stand-in Trail: answers the claim with `status` and `body`, and keeps what it was sent. */
function trail(status: number, body: object) {
  const sent: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

test("trail login --code: the web app's one-time code is traded for this laptop's token, with no browser step", async () => {
  const t = trail(200, {
    token: "trl_abc",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "acme", url: "http://trail.test/app/?w=acme", invite_url: "" },
    repos: ["github.com/acme/web"],
  });
  const got = await claimLoginCode("http://trail.test", "TRL-ABCD-EFGH-IJKL-MNOP", t.fetchImpl);
  assert.ok("cloud" in got);
  assert.equal(got.cloud.token, "trl_abc");
  assert.equal(got.cloud.workspace.slug, "acme");
  assert.deepEqual(got.cloud.repos, ["github.com/acme/web"]);
  assert.equal(t.sent[0]!.url, "http://trail.test/api/cli/login-codes/claim");
  assert.deepEqual(t.sent[0]!.body, { code: "TRL-ABCD-EFGH-IJKL-MNOP" });
});

test("trail login --code: a used or expired code says to copy a new one; a wrong one says what a code looks like", async () => {
  const gone = await claimLoginCode("http://trail.test", "TRL-ABCD-EFGH-IJKL-MNOP", trail(410, { error: "x" }).fetchImpl);
  assert.ok("error" in gone && gone.reason === "expired" && /copy a new one/.test(gone.error));
  const bad = await claimLoginCode("http://trail.test", "nope", trail(400, { error: "x" }).fetchImpl);
  assert.ok("error" in bad && bad.reason === "invalid" && /TRL-ABCD/.test(bad.error));
});

test("trail login --code writes to agents' home settings only with --global", async () => {
  const claim = JSON.stringify({
    token: "trl_abc",
    user: { name: "Priya", email: "priya@acme.test" },
    workspace: { id: "w1", name: "Acme", slug: "acme", url: "http://trail.test/app/?w=acme", invite_url: "" },
    repos: [],
  });
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(req.url === "/api/cli/login-codes/claim" ? 200 : 404, { "content-type": "application/json" });
    res.end(req.url === "/api/cli/login-codes/claim" ? claim : "{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [flags, written] of [[[], false], [["--global"], true]] as const) {
      const home = mkdtempSync(join(tmpdir(), "login-code-home-"));
      for (const dir of [".claude", ".codex", ".cursor"]) mkdirSync(join(home, dir));
      const repo = mkdtempSync(join(tmpdir(), "login-code-repo-"));
      const env = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), DO_NOT_TRACK: "1" };
      const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "login", repo, "--code", "TRL-ABCD-EFGH-IJKL-MNOP", "--server", url, ...flags], { env, stdio: "ignore" });
      const status = await new Promise((ok) => child.on("close", ok));
      assert.equal(status, 0);
      for (const f of [join(home, ".claude.json"), join(home, ".codex", "config.toml"), join(home, ".cursor", "mcp.json")]) {
        assert.equal(existsSync(f), written, f);
      }
    }
  } finally {
    server.close();
  }
});
