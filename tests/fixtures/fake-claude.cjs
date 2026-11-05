// 실제 계정 사용량 없이 서버가 Claude 자식 프로세스에 보낸 입력을 검증한다.
const cp = require("node:child_process");
const { PassThrough, Writable } = require("node:stream");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  if (command !== process.env.MSL_TEST_CLAUDE) return original.apply(this, arguments);
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let input = "";
  child.stdin = new Writable({ write(chunk, encoding, done) { input += chunk; done(); } });
  child.stdin.on("finish", () => {
    if (args.includes("--json-schema")) {
      const input = JSON.parse(inputText());
      const structured = input.round === 1
        ? { inspect: ["demo/site"], selected: [], message: "사이트 확인" }
        : { inspect: [], selected: [{ repository: "demo/site", reason: "요청한 사이트" }], message: "관련 코드 확인" };
      setTimeout(() => { child.stdout.write(JSON.stringify({ structured_output: structured })); child.emit("close", 0); }, 10);
      return;
    }
    fs.writeFileSync(path.join(options.cwd, "captured-prompt.txt"), input);
    setTimeout(() => {
      child.stdout.write(JSON.stringify({ type: "result", result: "테스트 실행 완료", total_cost_usd: 0 }) + "\n");
      child.emit("close", 0);
    }, 30);
  });
  function inputText() { return input; }
  return child;
};
if (process.env.MSL_TEST_GITHUB === "1") {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).startsWith("https://api.github.com/")) return originalFetch(url, options);
    let body;
    const endpoint = String(url).slice("https://api.github.com".length);
    if (endpoint === "/user") body = { login: "demo" };
    else if (endpoint.startsWith("/user/repos")) body = [{ full_name: "demo/site", default_branch: "main" }];
    else if (endpoint === "/repos/demo/site") body = { full_name: "demo/site", default_branch: "main" };
    else if (endpoint.endsWith("/commits/main")) body = { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } };
    else if (endpoint.includes("/git/trees/")) body = { tree: [{ path: "index.html", type: "blob", mode: "100644", size: 20, sha: "c".repeat(40) }] };
    else if (endpoint.includes("/git/blobs/")) body = { encoding: "base64", size: 20, content: Buffer.from("<h1>demo site</h1>").toString("base64") };
    else return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
