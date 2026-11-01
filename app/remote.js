// 휴대폰·외부 접속 (고급). 기본은 꺼져 있고, 사용자가 '시작 준비' 화면에서 켠다.
// - tailscale: 같은 Tailscale 계정으로 로그인한 내 기기에서만 https://내PC.xxx.ts.net:포트 로 연다.
//   Tailscale Serve가 접속한 사람의 로그인 이메일을 Tailscale-User-Login 머리글로 알려 주고, 밖에서 보낸 같은 머리글은 지운다.
// - cloudflare: 내 도메인 주소로 어디서나 연다. Cloudflare 터널 + Access(로그인 문). 터널 토큰으로 서버가 cloudflared를 함께 띄운다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const IS_WIN = process.platform === "win32";

// PATH에 없을 때도 찾도록 운영체제별 기본 설치 위치를 함께 본다
function findExe(name, candidates) {
  try {
    const out = execFileSync(IS_WIN ? "where" : "which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  return candidates.find(p => p && fs.existsSync(p)) || "";
}
const PF = process.env.ProgramFiles || "C:\\Program Files";
const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const tailscaleExe = () => findExe("tailscale", IS_WIN
  ? [path.join(PF, "Tailscale", "tailscale.exe")]
  : ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]);
const cloudflaredExe = () => findExe("cloudflared", IS_WIN
  ? [path.join(PF86, "cloudflared", "cloudflared.exe"), path.join(PF, "cloudflared", "cloudflared.exe")]
  : ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]);

// 명령을 실행해 출력을 모은다. 시간 안에 안 끝나면 끊는다 (Tailscale이 허락 링크를 띄우고 기다리는 경우).
function run(exe, args, timeoutMs) {
  return new Promise(resolve => {
    let out = "", timedOut = false;
    const p = spawn(exe, args, { windowsHide: true });
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { out += d; });
    const t = setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs);
    p.on("error", e => { clearTimeout(t); resolve({ code: -1, out: String(e.message), timedOut }); });
    p.on("close", code => { clearTimeout(t); resolve({ code, out, timedOut }); });
  });
}
const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };

// ── Tailscale ──────────────────────────────────────────
async function tailscaleStatus(port) {
  const exe = tailscaleExe();
  if (!exe) return { installed: false };
  const s = parseJson((await run(exe, ["status", "--json"], 8000)).out);
  if (!s || s.BackendState !== "Running") return { installed: true, running: false };
  const host = String(s.Self?.DNSName || "").replace(/\.$/, "").toLowerCase();
  const login = String(s.User?.[String(s.Self?.UserID)]?.LoginName || "").toLowerCase();
  let serving = false;
  if (host) {
    const sv = parseJson((await run(exe, ["serve", "status", "--json"], 8000)).out) || {};
    const proxy = sv.Web?.[`${host}:${port}`]?.Handlers?.["/"]?.Proxy || "";
    serving = new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy);
  }
  return { installed: true, running: true, host, login, serving, url: host ? `https://${host}:${port}/` : "" };
}

// 이 명령판 포트만 연다. 사용자가 Tailscale로 이미 열어 둔 다른 포트(예: 443)는 건드리지 않는다.
async function tailscaleOn(port) {
  const exe = tailscaleExe();
  if (!exe) throw new Error("Tailscale이 설치되어 있지 않습니다.");
  const r = await run(exe, ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`], 30000);
  // 처음 쓰는 계정은 HTTPS 인증서·Serve 사용을 허락하라는 링크가 나온다
  const link = (r.out.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0];
  if (link && (r.timedOut || r.code !== 0)) return { consentUrl: link };
  if (r.code !== 0) throw new Error("Tailscale 연결을 켜지 못했습니다: " + r.out.trim().slice(0, 300));
  return {};
}
async function tailscaleOff(port) {
  const exe = tailscaleExe();
  if (!exe) return;
  const r = await run(exe, ["serve", `--https=${port}`, "off"], 15000);
  if (r.code !== 0) await run(exe, ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`, "off"], 15000);
}

// ── Cloudflare 터널 ────────────────────────────────────
// 서버의 자식으로 띄우므로 서버가 꺼지면 함께 꺼진다. 토큰은 명령줄 대신 환경 변수로 넘긴다(작업 관리자에 안 보이게).
let cf = { proc: null, connected: false, lastError: "" };
function cloudflareStart(token, logDir) {
  if (cf.proc) return;
  const exe = cloudflaredExe();
  if (!exe) { cf.lastError = "cloudflared가 설치되어 있지 않습니다."; return; }
  if (!token) { cf.lastError = "터널 토큰이 없습니다."; return; }
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, "tunnel.log"), { flags: "a" });
  cf = { proc: null, connected: false, lastError: "" };
  const p = spawn(exe, ["tunnel", "--no-autoupdate", "run"], { windowsHide: true, env: { ...process.env, TUNNEL_TOKEN: token } });
  cf.proc = p;
  const watch = d => {
    log.write(d);
    const s = String(d);
    if (/Registered tunnel connection/i.test(s)) cf.connected = true;
    if (/Unauthorized|invalid token|failed to unmarshal/i.test(s)) cf.lastError = "터널 토큰이 맞지 않습니다. Cloudflare에서 다시 복사해 주세요.";
  };
  p.stdout.on("data", watch);
  p.stderr.on("data", watch);
  p.on("error", e => { cf.lastError = e.message; });
  p.on("close", code => {
    log.end(`\n(cloudflared 종료: ${code})\n`);
    if (cf.proc === p) cf = { proc: null, connected: false, lastError: cf.lastError || `터널이 멈췄습니다 (종료 코드 ${code}).` };
  });
}
function cloudflareStop() {
  const p = cf.proc;
  cf = { proc: null, connected: false, lastError: "" };
  if (p) p.kill();
}
const cloudflareStatus = () => ({ installed: !!cloudflaredExe(), running: !!cf.proc, connected: cf.connected, error: cf.lastError });

// ── 설정 저장 ──────────────────────────────────────────
// config.json의 remote만 바꾸고 나머지(포트·작업 폴더)는 그대로 둔다. 실행 중인 설정 객체도 바로 고친다.
function saveRemote(configFile, remote, patch) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configFile, "utf8")); } catch {}
  Object.assign(remote, patch);
  const { enabled, ...rest } = remote; // 예전 enabled 칸은 mode로 바뀌었다
  cfg.remote = rest;
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}

module.exports = { tailscaleStatus, tailscaleOn, tailscaleOff, cloudflareStart, cloudflareStop, cloudflareStatus, saveRemote };
