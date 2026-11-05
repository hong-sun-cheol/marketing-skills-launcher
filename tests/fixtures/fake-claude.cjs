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
    fs.writeFileSync(path.join(options.cwd, "captured-prompt.txt"), input);
    setTimeout(() => {
      child.stdout.write(JSON.stringify({ type: "result", result: "테스트 실행 완료", total_cost_usd: 0 }) + "\n");
      child.emit("close", 0);
    }, 30);
  });
  return child;
};
