"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough, Writable } = require("node:stream");
const { EventEmitter } = require("node:events");
const { askClaude, findRelated } = require("../app/repository-finder.js");
const catalog = [{ fullName: "demo/website", description: "사이트" }, { fullName: "demo/service-api", description: "별도 서버" }, { fullName: "demo/other", description: "다른 서비스" }];
test("site name → source inspection → separately named API repository → combined selection", async () => {
  const visited = [];
  const result = await findRelated({ instruction: "website 관련 서버 코드도 함께 넣어 줘", catalog,
    inspect: async name => { visited.push(name); return { repository: name, files: [{ path: "app.js", excerpt: name === "demo/website" ? "API=https://service-api.example.com; source=demo/service-api" : "service-api server" }] }; },
    ask: async input => {
      if (input.round === 1) return { inspect: ["demo/website"], selected: [], message: "사이트부터 확인" };
      if (input.round === 2) { assert.match(input.inspected[0].files[0].excerpt, /service-api/); return { inspect: ["demo/service-api"], selected: [], message: "서버 연결 확인" }; }
      assert.equal(input.finalRound, true);
      return { inspect: [], selected: [{ repository: "demo/website", reason: "대상 사이트" }, { repository: "demo/service-api", reason: "사이트가 호출하는 API 서버" }], message: "사이트와 서버를 찾았습니다." };
    } });
  assert.deepEqual(visited, ["demo/website", "demo/service-api"]);
  assert.equal(result.selected.length, 2);
  assert.equal(result.warnings.length, 0);
});
test("reject invented or uninspected repositories and empty requests", async () => {
  const base = { instruction: "사이트", catalog, inspect: async () => ({}) };
  await assert.rejects(findRelated({ ...base, ask: async () => ({ inspect: ["attacker/secret"], selected: [] }) }), /목록에 없는/);
  await assert.rejects(findRelated({ ...base, ask: async () => ({ inspect: [], selected: [{ repository: "demo/website", reason: "추측" }] }) }), /확인하지 못한/);
  await assert.rejects(findRelated({ ...base, instruction: " ", ask: async () => assert.fail("should not call") }), /요청/);
});
test("unavailable code is reported without selecting it", async () => {
  const result = await findRelated({ instruction: "사이트", catalog, inspect: async () => { throw new Error("forbidden"); },
    ask: async input => input.round === 1 ? { inspect: ["demo/website"], selected: [] } : { inspect: [], selected: [], message: "코드를 확인할 수 없습니다." } });
  assert.equal(result.selected.length, 0); assert.match(result.warnings[0], /읽지 못했습니다/);
});
test("Claude adapter passes only supplied context and disables execution tools", async () => {
  let captured = "";
  const result = await askClaude("test-claude", { instruction: "사이트 찾기", catalog }, { spawnProcess: (command, args, options) => {
    assert.equal(command, "test-claude");
    assert.equal(args[args.indexOf("--tools") + 1], ""); assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(options.windowsHide, true);
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.stdin = new Writable({ write(b, enc, done) { captured += b; done(); } });
    p.stdin.on("finish", () => { p.stdout.write(JSON.stringify({ structured_output: { inspect: ["demo/website"], selected: [], message: "확인" } })); p.emit("close", 0); });
    return p;
  } });
  assert.deepEqual(JSON.parse(captured).catalog, catalog); assert.deepEqual(result.inspect, ["demo/website"]);
});
