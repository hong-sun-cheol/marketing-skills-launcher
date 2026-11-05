"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeMaterials, sourceFile, MAX_IMAGE } = require("../app/materials.js");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
function fixture(t, overrides = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "marketing-materials-"));
  const root = path.join(temp, "app"), project = path.join(temp, "work");
  fs.mkdirSync(root); fs.mkdirSync(project);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const calls = [];
  const fetcher = async (url, opts) => {
    assert.equal(opts.headers.authorization, "Bearer test-key");
    assert.equal(opts.redirect, "error");
    calls.push(url);
    let data;
    if (url.endsWith("/user")) data = { login: "tester" };
    else if (url.includes("/user/repos?")) data = [{ full_name: "tester/site", private: true, default_branch: "main" }, { full_name: "tester/server", description: "사이트 API 서버", default_branch: "main" }];
    else if (/\/repos\/tester\/(site|server)$/.test(url)) data = { full_name: "tester/" + url.split("/").at(-1), default_branch: "main" };
    else if (url.endsWith("/commits/main")) data = { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } };
    else if (url.includes("/git/trees/")) data = { truncated: true, tree: [
      { path: "app/page.tsx", type: "blob", mode: "100644", size: 20, sha: "c".repeat(40) },
      { path: ".env.local", type: "blob", mode: "100644", size: 20, sha: "secret" },
      { path: "link.js", type: "blob", mode: "120000", size: 20, sha: "link" },
      { path: "large.js", type: "blob", mode: "100644", size: 999999, sha: "large" },
    ] };
    else if (url.includes("/git/blobs/")) data = { encoding: "base64", size: 20, content: Buffer.from("export default 'hi';").toString("base64") };
    else throw new Error("Unexpected URL " + url);
    return { ok: true, json: async () => data };
  };
  const args = { root, project, fetcher, cliToken: async () => "test-key", ...overrides };
  return { m: makeMaterials(args), root, project, calls, args };
}
test("CLI connection stores no token; paginated repo list; disconnect leaves CLI intact", async t => {
  const { m, root, calls } = fixture(t);
  await assert.rejects(m.repos(), /먼저 GitHub/);
  assert.equal((await m.connect({ mode: "cli" })).login, "tester");
  assert.equal(fs.readFileSync(path.join(root, "github-auth.json"), "utf8").includes("test-key"), false);
  assert.equal((await m.repos(2)).repos[0].fullName, "tester/site");
  assert.match(calls.at(-1), /page=2$/);
  await assert.rejects(m.repos(-1), /목록 번호/);
  assert.equal(m.disconnect().connected, false);
});
test("PAT stays out of status and survives restart; failed reconnect preserves working connection", async t => {
  const { m, args } = fixture(t);
  await m.connect({ mode: "token", token: "test-key" });
  const restarted = makeMaterials(args);
  assert.deepEqual(restarted.status(), { connected: true, login: "tester", mode: "token" });
  await assert.rejects(m.connect({ mode: "token", token: "" }));
  assert.equal(m.status().connected, true);
});
test("pinned code snapshot omits secrets, symlinks and oversize files; context names actual files", async t => {
  const { m, project, calls } = fixture(t);
  await m.connect({ mode: "cli" });
  const repo = await m.importRepo("tester/site");
  assert.equal(repo.count, 1); assert.equal(repo.excluded, 3);
  assert.match(repo.warning, /일부만/);
  assert.equal(calls.some(u => u.endsWith("/secret") || u.endsWith("/link")), false);
  const saved = JSON.parse(fs.readFileSync(path.join(project, repo.path), "utf8"));
  assert.equal(saved.files[0].path, "app/page.tsx");
  assert.equal(fs.readFileSync(path.join(project, path.dirname(repo.path), saved.files[0].localFile), "utf8"), "export default 'hi';");
  const ctx = m.context([repo.id]);
  assert.match(ctx.prompt, /제외된 파일/); assert.ok(ctx.prompt.includes(repo.path));
  await assert.rejects(m.importRepo("https://evil.test/repo"));
  assert.throws(() => m.context([repo.id, repo.id]));
});
test("image round trip, reference validation and attachment limits", t => {
  const { m, project } = fixture(t);
  const image = m.upload({ name: "통계.png", data: PNG });
  assert.equal(m.preview(image.id).bytes.toString("base64"), PNG);
  assert.equal(m.preview(image.id).mime, "image/png");
  assert.match(m.context([image.id]).prompt, /기간·단위·수치/);
  assert.throws(() => m.get("../../config"));
  assert.throws(() => m.get("a".repeat(32)), /없습니다/);
  assert.throws(() => m.upload({ name: "fake.png", data: Buffer.from("<svg></svg>").toString("base64") }));
  assert.throws(() => m.upload({ data: "a".repeat(Math.ceil(MAX_IMAGE / 3) * 4 + 4) }));
  const ids = Array.from({ length: 7 }, () => m.upload({ data: PNG }).id);
  assert.throws(() => m.context(ids), /최대 6개/);
  fs.unlinkSync(path.join(project, image.path));
  assert.throws(() => m.context([image.id]), /첨부 파일이 없습니다/);
});
test("source filter excludes generated and credential material", () => {
  for (const p of [".env", ".env.production", "config.json", "secrets.json", "credentials.json", "node_modules/a.js", "dist/app.js", "foo.min.js", "package-lock.json", "a/../../b.js"]) assert.equal(sourceFile(p), false, p);
  for (const p of ["app/page.tsx", "src/pricing.vue", "README.md", "public/robots.txt", "src/routes/+page.svelte"]) assert.equal(sourceFile(p), true, p);
});
test("automatic discovery attaches site plus server and passes both sources to existing skill", async t => {
  const { m } = fixture(t);
  await m.connect({ mode: "cli" });
  const found = await m.discover("site 관련 서버 코드까지 넣어 줘", async input => {
    if (input.round === 1) return { inspect: ["tester/site"], selected: [], message: "사이트 확인" };
    if (input.round === 2) { assert.equal(input.inspected[0].files[0].path, "app/page.tsx"); return { inspect: ["tester/server"], selected: [], message: "서버 확인" }; }
    return { inspect: [], selected: [{ repository: "tester/site", reason: "사이트 코드" }, { repository: "tester/server", reason: "관련 서버 코드" }], message: "둘 다 첨부" };
  });
  assert.equal(found.materials.length, 2);
  assert.equal(found.materials[1].sourceNote, "관련 서버 코드");
  const context = m.context(found.materials.map(r => r.id));
  assert.ok(context.prompt.includes("tester/site")); assert.ok(context.prompt.includes("tester/server"));
  const duplicate = await m.importRepo("tester/site");
  assert.throws(() => m.context([found.materials[0].id, duplicate.id]), /중복 첨부/);
});
test("auth and network errors are actionable and never echo credentials", async t => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    const { m } = fixture(t, { fetcher: async () => ({ ok: false, status }) });
    await assert.rejects(m.connect({ mode: "token", token: "private-key" }), e => !e.message.includes("private-key") && e.status >= 400);
    assert.equal(m.status().connected, false);
  }
});
