// 새 버전 확인과 업데이트.
// GitHub 릴리스(Releases, 버전별 배포 기록)의 최신판을 보고, 사용자가 [지금 업데이트]를 누르면
// zip을 받아 그 안의 설치 스크립트를 한 번 더 돌린다. 설치 스크립트는 설정·사업 정보·결과물을 지킨다.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const REPO = "hong-sun-cheol/marketing-skills-launcher";
const API = process.env.MSL_UPDATE_API || "https://api.github.com"; // 시험할 때만 가짜 서버 주소로 바꾼다
const CHECK_EVERY = 6 * 60 * 60 * 1000; // GitHub는 로그인 없이 시간당 60번까지만 물어볼 수 있어 결과를 6시간 기억한다
const IS_WIN = process.platform === "win32";
const UA = { "user-agent": "marketing-skills-launcher", accept: "application/vnd.github+json" };

// latest(릴리스 태그, 예: "v0.2.0")가 current(설치된 버전, 예: "0.1.0")보다 새것이면 true.
// 글자로 비교하면 "0.10.0"이 "0.9.0"보다 작게 나오므로 점으로 나눠 숫자끼리 앞자리부터 비교한다.
// "beta"처럼 숫자가 아닌 태그는 잘못된 알림을 막으려고 새 버전으로 보지 않는다. 없는 자리는 0으로 본다("0.2" = "0.2.0").
function isNewer(latest, current) {
  const parse = v => { const m = String(v).trim().replace(/^v/i, "").match(/^\d+(\.\d+)*$/); return m ? m[0].split(".").map(Number) : null; };
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function makeUpdater({ installDir, workDir, port, logDir }) {
  const current = () => { try { return fs.readFileSync(path.join(installDir, "VERSION"), "utf8").trim(); } catch { return "0.0.0"; } };
  // 설치판(설치 스크립트로 깐 것)에서만 스스로 업데이트할 수 있다. 개발용 폴더에서는 알림만 보여 준다.
  const installed = fs.existsSync(path.join(installDir, "runtime")) && fs.existsSync(path.join(installDir, IS_WIN ? "stop.cmd" : "stop.sh"));
  let cache = null, cachedAt = 0, busy = false;
  cleanOldTemp();

  async function check(force = false) {
    if (!force && cache && Date.now() - cachedAt < CHECK_EVERY) return cache;
    const base = { current: current(), canApply: installed, busy };
    try {
      const r = await fetch(`${API}/repos/${REPO}/releases/latest`, { headers: UA, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) cache = { ...base, available: false }; // 아직 릴리스를 하나도 올리지 않음
      else if (!r.ok) throw new Error(`GitHub 응답 ${r.status}`);
      else {
        const rel = await r.json();
        const asset = (rel.assets || []).find(a => /\.zip$/i.test(a.name));
        cache = {
          ...base,
          latest: String(rel.tag_name || "").replace(/^v/i, ""),
          available: !!asset && !!isNewer(String(rel.tag_name || ""), base.current),
          notes: String(rel.body || "").slice(0, 4000),
          page: rel.html_url || `https://github.com/${REPO}/releases/latest`,
          asset: asset ? { url: asset.browser_download_url, size: asset.size, digest: asset.digest || "" } : null,
        };
      }
      cachedAt = Date.now();
      return cache;
    } catch {
      // 인터넷이 끊겨도 명령판은 그대로 쓸 수 있어야 하므로 조용히 "확인 못 함"만 알린다
      return { ...base, available: false, error: "새 버전을 확인하지 못했습니다. 인터넷 연결을 확인해 주세요." };
    }
  }

  // 화면에 보낼 때는 내려받기 주소 같은 내부 정보를 뺀다
  const view = info => { const { asset, ...rest } = info; return { ...rest, busy }; };

  async function apply() {
    if (busy) throw new Error("이미 업데이트 중입니다.");
    if (!installed) throw new Error("설치 파일로 설치한 명령판에서만 업데이트할 수 있습니다.");
    const info = await check(true);
    if (!info.available) throw new Error("받을 새 버전이 없습니다.");
    busy = true;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msl-update-"));
    try {
      const r = await fetch(info.asset.url, { headers: { "user-agent": UA["user-agent"] }, signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (!r.ok) throw new Error(`새 버전 파일을 받지 못했습니다 (${r.status}).`);
      const buf = Buffer.from(await r.arrayBuffer());
      // GitHub가 알려 주는 파일 지문(SHA-256)이 있으면 받은 파일과 대조한다
      if (/^sha256:/i.test(info.asset.digest)) {
        const got = crypto.createHash("sha256").update(buf).digest("hex");
        if (got !== info.asset.digest.slice(7).toLowerCase()) throw new Error("받은 파일의 지문이 맞지 않습니다. 잠시 뒤 다시 시도해 주세요.");
      }
      const zip = path.join(tmp, "update.zip");
      const out = path.join(tmp, "files");
      fs.writeFileSync(zip, buf);
      fs.mkdirSync(out);
      // Windows 10 이상에는 tar가, Mac에는 ditto가 기본으로 있어 zip을 풀 수 있다.
      // Windows는 경로를 못 박는다. Git 등이 깐 다른 tar가 먼저 잡히면 zip을 못 푼다.
      if (IS_WIN) execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", out]);
      else execFileSync("ditto", ["-x", "-k", zip, out]);
      // zip 안에 폴더가 한 겹 더 있을 수 있어서 설치 스크립트가 있는 곳을 찾는다
      const script = path.join("installer", IS_WIN ? "install.ps1" : "install.sh");
      const root = [out, ...fs.readdirSync(out).map(n => path.join(out, n))].find(d => fs.existsSync(path.join(d, script)));
      if (!root) throw new Error("받은 파일에 설치 스크립트가 없습니다.");

      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "update.log");
      // 설치 스크립트를 이 서버와 떨어진 별도 프로세스로 띄운다. 서버는 곧 스스로 꺼지고,
      // 설치 스크립트는 포트가 빌 때까지 기다렸다가 파일을 바꾼 뒤 서버를 다시 켠다.
      if (IS_WIN) {
        // cmd를 거쳐 띄운다 (2026-11-01 시험 결과). powershell을 직접 detached로 띄우면 콘솔이 없어 아무것도 안 하고 끝나고,
        // detached 없이 띄우면 Node가 자식들을 한 묶음(job)으로 관리해서 서버가 꺼질 때 같이 꺼진다.
        const q = s => `"${s}"`;
        const line = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", q(path.join(root, script)),
          "-InstallDir", q(installDir), "-WorkDir", q(workDir), "-Port", String(port), "-Update"].join(" ");
        // 진행 기록은 설치 스크립트가 update.log에 직접 남긴다. 콘솔 없이 돌면 >> 로는 안 남고,
        // 여기서 BOM 없이 먼저 쓰면 PowerShell이 이어 쓰며 한글을 ?로 바꾼다.
        spawn("cmd.exe", ["/d", "/s", "/c", q(line)], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true, cwd: tmp }).unref();
      } else {
        const log = fs.openSync(logFile, "a");
        fs.writeSync(log, `\n==== ${new Date().toISOString()} ${info.current} -> ${info.latest}\n`);
        spawn("/bin/bash", [path.join(root, script)], { detached: true, stdio: ["ignore", log, log], cwd: tmp,
          env: { ...process.env, INSTALL_DIR: installDir, WORK_DIR: workDir, PORT: String(port), UPDATE: "1" } }).unref();
        fs.closeSync(log);
      }
      return { version: info.latest };
    } catch (e) {
      busy = false;
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  // 지난 업데이트 때 받은 임시 파일을 치운다 (설치가 끝난 지 한참 지난 것만)
  function cleanOldTemp() {
    try {
      for (const n of fs.readdirSync(os.tmpdir())) {
        if (!n.startsWith("msl-update-")) continue;
        const p = path.join(os.tmpdir(), n);
        if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }

  return { check: async force => view(await check(force)), apply };
}

module.exports = { makeUpdater, isNewer };
