// 마케팅 스킬 명령판 (배포판)
// 화면에서 고른 스킬을 이 컴퓨터의 Claude Code로 실행하고, 진행 상황과 결과를 돌려준다.
// 실행 비용은 이 컴퓨터에 로그인한 사용자 본인의 Claude 계정에서 나간다.
// 기본은 이 컴퓨터에서만 열린다. 휴대폰·외부 접속은 config.json의 remote.mode로 켠다
// ("tailscale": 내 기기에서만 / "cloudflare": 내 도메인 + Access 로그인). '시작 준비' 화면에서 바꾼다.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { setupStatus, saveSetup } = require("./setup.js");
const { makeUpdater } = require("./update.js");
const remoteKit = require("./remote.js");

const ROOT = __dirname;
const IS_WIN = process.platform === "win32";

// ── 설정 ──────────────────────────────────────────────
// config.json이 없거나 일부만 있어도 동작하도록 기본값과 합친다. 개인 정보는 코드에 두지 않는다.
const DEFAULTS = {
  port: 8787,
  projectDir: path.join(os.homedir(), "Documents", "마케팅작업실"),
  claudeExe: "",
  remote: { mode: "", publicHost: "", accessTeam: "", accessAud: "", tunnelToken: "", tailscaleHost: "", allowedEmails: [] },
};
function loadConfig() {
  const file = path.join(ROOT, "config.json");
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.error("config.json을 읽지 못해 기본값으로 시작합니다:", e.message); }
  }
  // 빈 문자열·null은 "안 적음"으로 보고 기본값을 쓴다 (예시 파일을 그대로 복사한 경우 대비).
  const filled = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== "" && v != null));
  return { ...DEFAULTS, ...filled(user), remote: { ...DEFAULTS.remote, ...filled(user.remote) } };
}
const CONFIG = loadConfig();
const REMOTE = CONFIG.remote;
// mode가 없는 예전 설정은 enabled: true면 cloudflare, 아니면 꺼짐으로 읽는다
if (!["off", "tailscale", "cloudflare"].includes(REMOTE.mode)) REMOTE.mode = REMOTE.enabled ? "cloudflare" : "off";
const PROJECT = CONFIG.projectDir;
const PORT = CONFIG.port;
const JOB_DIR = path.join(ROOT, "jobs");
const MCP_FILE = path.join(ROOT, "mcp.json"); // 설치 파일이 만든다 (Playwright 브라우저 도구)
const RESULT_FOLDERS = ["기획", "카피", "광고", "SEO", "이메일", "SNS", "분석", ".agents"];
const MAX_RUN_MS = 30 * 60 * 1000;
fs.mkdirSync(JOB_DIR, { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });
// 설치 폴더는 app 폴더의 한 단계 위다 (VERSION, runtime, stop.cmd가 있는 곳)
const updater = makeUpdater({ installDir: path.dirname(ROOT), workDir: PROJECT, port: PORT, logDir: path.join(ROOT, "logs") });

// Claude Code 실행 파일 찾기. 설치 방법(npm, 공식 설치 스크립트)과 운영체제마다 위치가 다르다.
// Windows에서 npm이 만든 claude.cmd는 셸 없이 바로 실행할 수 없어서 옆의 claude.exe를 찾아 쓴다.
function findClaude() {
  if (CONFIG.claudeExe && fs.existsSync(CONFIG.claudeExe)) return CONFIG.claudeExe;
  const found = [];
  try {
    const out = execFileSync(IS_WIN ? "where" : "which", IS_WIN ? ["claude"] : ["-a", "claude"], { encoding: "utf8" });
    found.push(...out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  } catch {}
  const candidates = [];
  for (const f of found) {
    if (!IS_WIN || /\.exe$/i.test(f)) candidates.push(f);
    else candidates.push(path.join(path.dirname(f), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  }
  candidates.push(path.join(os.homedir(), ".local", "bin", IS_WIN ? "claude.exe" : "claude"));
  return candidates.find(c => fs.existsSync(c)) || null;
}
// 명령판이 켜진 뒤에 Claude Code를 설치해도 껐다 켤 필요가 없게, 못 찾았으면 쓸 때마다 다시 찾는다.
let CLAUDE = findClaude();
function claudePath() { if (!CLAUDE) CLAUDE = findClaude(); return CLAUDE; }

// Claude Code에 허용할 도구. 나머지는 dontAsk 모드에서 묻지 않고 거절된다.
// 브라우저(Playwright)는 보기 도구만 연다. 클릭·입력은 지켜보는 사람이 없으니 막아 둔다.
const BROWSER_TOOLS = ["browser_navigate", "browser_navigate_back", "browser_snapshot",
  "browser_take_screenshot", "browser_evaluate", "browser_resize", "browser_wait_for",
  "browser_tabs", "browser_close"].map(t => `mcp__playwright__${t}`);
// 배포판은 남의 PC에서 사람 없이 돈다. 그래서 파일 쓰기는 작업 폴더 안(./**)으로만 묶고,
// 셸 명령(Bash)은 하나도 열지 않는다. curl도 -o로 폴더 밖에 쓸 수 있어 뺐다.
// WebFetch로 안 열리는 페이지(네이버 등)는 브라우저 보기 도구로 읽는다.
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Skill",
  "Write(./**)", "Edit(./**)", ...BROWSER_TOOLS];

// 자동 실행 때 매번 헤매지 않도록 덧붙이는 안내.
const RUN_GUIDE = [
  "이 실행은 웹 실행기에서 사람 없이 돌아간다. 허용 안 된 도구는 묻지 않고 거절된다.",
  "웹 페이지가 WebFetch로 안 열리면(네이버 등) Playwright(mcp__playwright__browser_navigate·snapshot·evaluate·take_screenshot)로 화면을 직접 연다. 추측 보고서로 끝내지 않는다.",
  "셸 명령(Bash)은 허용되지 않으니 시도하지 않는다. 스크린샷은 .playwright-mcp/ 폴더에 저장한다.",
  "네이버 블로그 글 목록은 Playwright로 https://rss.blog.naver.com/아이디.xml 을 열어 읽을 수 있다.",
  "네이버 블로그 팁: 글 목록·카테고리 수는 m.blog.naver.com 페이지에서 fetch('/api/blogs/아이디/category-list'),",
  "글 본문은 blog.naver.com/PostView.naver?blogId=아이디&logNo=번호 의 .se-main-container,",
  "검색 순위는 search.naver.com 페이지에서 fetch('/search.naver?ssc=tab.blog.all&query=검색어')로 잰다. 다른 도메인끼리 fetch는 막힌다.",
  "이 작업 폴더 밖의 파일은 읽거나 쓰지 않는다.",
].join("\n");

// ── 접속 검사 ──────────────────────────────────────────
// 터널을 거친 요청에는 Cloudflare가 cf-ray 등의 머리글을 붙인다. 그런 요청은 Access 로그인 서명이 있어야 한다.
// 머리글이 없으면 이 컴퓨터에서 직접 연 요청(127.0.0.1에만 열려 있음)이다.
let jwks = { keys: [], at: 0 };
async function loadKeys(force) {
  if (!force && jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  const r = await fetch(`https://${REMOTE.accessTeam}/cdn-cgi/access/certs`);
  const j = await r.json();
  jwks = { keys: j.keys || [], at: Date.now() };
  return jwks.keys;
}
async function verifyAccess(token) {
  if (!token || !REMOTE.accessAud) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  let key = (await loadKeys(false)).find(k => k.kid === header.kid);
  if (!key) key = (await loadKeys(true)).find(k => k.kid === header.kid);
  if (!key || header.alg !== "RS256") return null;
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`),
    crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(REMOTE.accessAud)) return null;
  if (claims.iss !== `https://${REMOTE.accessTeam}`) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  const email = String(claims.email || "").toLowerCase();
  if (!REMOTE.allowedEmails.map(e => e.toLowerCase()).includes(email)) return null;
  return email;
}
// 어디서 온 요청인지 보고 거절 이유를 돌려준다(통과면 null). 통과한 외부 요청에는 req.remoteUser(이메일)를 붙인다.
async function checkRequest(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const mode = REMOTE.mode;
  const cfHost = mode === "cloudflare" && REMOTE.publicHost ? REMOTE.publicHost.toLowerCase() : null;
  const tsHost = mode === "tailscale" && REMOTE.tailscaleHost ? `${REMOTE.tailscaleHost.toLowerCase()}:${PORT}` : null;
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, cfHost, tsHost].filter(Boolean);
  if (!allowedHosts.includes(host)) return "허용되지 않은 주소로 들어온 요청입니다.";
  const allowed = email => REMOTE.allowedEmails.map(e => String(e).toLowerCase()).includes(email);
  // Cloudflare 터널을 거친 요청에는 cf-ray 등이, Tailscale Serve를 거친 요청에는 Tailscale-User-Login이 붙는다.
  // 둘 다 없으면 이 컴퓨터에서 직접 연 요청이다(서버는 127.0.0.1에만 열려 있다).
  const viaCf = req.headers["cf-ray"] || req.headers["cf-connecting-ip"] || req.headers["cf-access-jwt-assertion"] || (cfHost && host === cfHost);
  const viaTs = req.headers["tailscale-user-login"] !== undefined || (tsHost && host === tsHost);
  if (viaCf) {
    if (!cfHost) return "외부 접속이 꺼져 있습니다.";
    const email = await verifyAccess(req.headers["cf-access-jwt-assertion"]).catch(() => null);
    if (!email) return "Cloudflare 로그인 확인에 실패했습니다.";
    req.remoteUser = email;
  } else if (viaTs) {
    if (mode !== "tailscale") return "외부 접속이 꺼져 있습니다.";
    // 태그 붙은 기기 등은 이메일 머리글이 비어 온다. 허락한 계정만 들인다.
    const email = String(req.headers["tailscale-user-login"] || "").toLowerCase();
    if (!email || !allowed(email)) return "허락되지 않은 Tailscale 계정입니다.";
    req.remoteUser = email;
  }
  if (req.method !== "GET") {
    // 다른 사이트가 몰래 실행 요청을 보내지 못하게, 화면이 붙이는 머리글을 확인한다.
    if (req.headers["x-runner"] !== "1") return "잘못된 요청입니다.";
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some(h => origin === `http://${h}` || origin === `https://${h}`)) return "다른 사이트에서 온 요청입니다.";
  }
  return null;
}

// ── 작업 ──────────────────────────────────────────────
const jobs = new Map();
const queue = [];
let running = null;

function publicJob(j, full) {
  const base = { id: j.id, skill: j.skill, title: j.title, status: j.status, createdAt: j.createdAt,
    startedAt: j.startedAt, endedAt: j.endedAt, files: j.files, cost: j.cost };
  return full ? { ...base, prompt: j.prompt, events: j.events, result: j.result } : base;
}
function saveJob(j) {
  fs.writeFileSync(path.join(JOB_DIR, j.id + ".json"), JSON.stringify(publicJob(j, true), null, 1));
}
function loadJobs() {
  for (const f of fs.readdirSync(JOB_DIR).filter(f => f.endsWith(".json"))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(JOB_DIR, f), "utf8"));
      if (j.status === "running" || j.status === "queued") j.status = "error";
      j.clients = new Set();
      jobs.set(j.id, j);
    } catch {}
  }
}
function send(j, type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of j.clients) res.write(msg);
}
function addEvent(j, kind, text) {
  const ev = { t: Date.now(), kind, text };
  j.events.push(ev);
  send(j, "event", ev);
}
function setStatus(j, status) {
  j.status = status;
  if (status === "running") j.startedAt = Date.now();
  if (["done", "error", "canceled"].includes(status)) j.endedAt = Date.now();
  send(j, "state", publicJob(j, false));
}

const rel = p => {
  const r = path.relative(PROJECT, path.resolve(PROJECT, String(p || "")));
  return r.split(path.sep).join("/");
};
function describeTool(name, input = {}) {
  switch (name) {
    case "WebFetch": return `웹 페이지 읽기: ${input.url || ""}`;
    case "WebSearch": return `검색: ${input.query || ""}`;
    case "Read": return `파일 읽기: ${rel(input.file_path)}`;
    case "Glob": case "Grep": return `파일 찾기: ${input.pattern || ""}`;
    case "Write": return `파일 저장: ${rel(input.file_path)}`;
    case "Edit": return `파일 수정: ${rel(input.file_path)}`;
    case "Bash": return `명령 실행: ${String(input.command || "").slice(0, 120)}`;
    case "Skill": return `스킬 불러오기: ${input.skill || ""}`;
    default: return `${name} 사용`;
  }
}

function startNext() {
  if (running || !queue.length) return;
  const j = queue.shift();
  running = j;
  setStatus(j, "running");
  addEvent(j, "info", "Claude Code를 시작했습니다.");

  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk",
    "--settings", JSON.stringify({ outputStyle: "default" }),
    "--append-system-prompt", RUN_GUIDE];
  // 설치 파일이 만든 브라우저 도구 설정이 있으면 그것만 쓴다(사용자의 다른 MCP 설정은 섞지 않음).
  if (fs.existsSync(MCP_FILE)) args.push("--mcp-config", MCP_FILE, "--strict-mcp-config");
  args.push("--allowedTools", ...ALLOWED_TOOLS);
  if (!claudePath()) {
    addEvent(j, "error", "Claude Code를 찾지 못했습니다. '시작 준비' 화면의 안내대로 설치해 주세요.");
    setStatus(j, "error"); saveJob(j); running = null; return startNext();
  }
  // Mac·리눅스는 새 프로세스 그룹으로 띄워야 취소할 때 하위 프로세스까지 함께 멈출 수 있다.
  const child = spawn(CLAUDE, args, { cwd: PROJECT, windowsHide: true, detached: !IS_WIN });
  j.pid = child.pid;
  child.stdin.end(j.prompt);
  const toolNames = new Map();
  let buf = "";
  child.stdout.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "assistant") {
        for (const c of m.message?.content || []) {
          if (c.type === "tool_use") {
            toolNames.set(c.id, c.name);
            addEvent(j, "tool", describeTool(c.name, c.input));
            if ((c.name === "Write" || c.name === "Edit") && c.input?.file_path) {
              const f = rel(c.input.file_path);
              if (!j.files.includes(f)) j.files.push(f);
            }
          } else if (c.type === "text" && c.text.trim()) {
            addEvent(j, "text", c.text.trim().slice(0, 400));
          }
        }
      } else if (m.type === "user") {
        for (const c of m.message?.content || []) {
          if (c.type === "tool_result" && c.is_error) {
            const name = toolNames.get(c.tool_use_id) || "도구";
            const txt = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
            addEvent(j, "warn", /denied|권한/.test(txt) ? `${name}: 허용 안 된 동작이라 건너뜀` : `${name}: 오류 (${txt.slice(0, 120)})`);
          }
        }
      } else if (m.type === "result") {
        j.result = m.result || "";
        j.cost = m.total_cost_usd ?? null;
        j.isError = !!m.is_error;
      }
    }
  });
  let errText = "";
  child.stderr.on("data", d => { errText += d; });
  const timer = setTimeout(() => { addEvent(j, "error", "30분이 지나 작업을 멈췄습니다."); killTree(child.pid); }, MAX_RUN_MS);
  child.on("close", code => {
    clearTimeout(timer);
    if (j.status !== "canceled") {
      if (code === 0 && !j.isError) {
        j.files = j.files.filter(f => fs.existsSync(path.join(PROJECT, f)));
        setStatus(j, "done");
      } else {
        if (errText.trim()) addEvent(j, "error", errText.trim().slice(0, 500));
        setStatus(j, "error");
      }
    }
    send(j, "result", { result: j.result, files: j.files, cost: j.cost });
    saveJob(j);
    running = null;
    startNext();
  });
  child.on("error", e => { addEvent(j, "error", "Claude Code를 실행하지 못했습니다: " + e.message); });
}
function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) return execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
}

// ── 브랜드 목록 ───────────────────────────────────────
// 작업 폴더의 .agents/brands.json에 사용자가 등록한 브랜드를 읽는다(첫 실행 화면에서 만든다).
// 없으면 기본 문서 하나만 쓴다. 화면은 /brands.js로 이 목록을 받는다.
function loadBrands() {
  const file = path.join(PROJECT, ".agents", "brands.json");
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    const ok = Array.isArray(list) ? list.filter(b => b && b.key && b.name && /^\.agents\/[^/\\]+\.md$/.test(b.doc || "")) : [];
    if (ok.length) return ok.map(b => ({ key: String(b.key), name: String(b.name), doc: b.doc, site: String(b.site || "") }));
  } catch {}
  return [{ key: "main", name: "내 사업", doc: ".agents/product-marketing.md", site: "" }];
}

// ── 결과 파일 ─────────────────────────────────────────
function listFiles() {
  const out = [];
  for (const folder of RESULT_FOLDERS) {
    const dir = path.join(PROJECT, folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const st = fs.statSync(path.join(dir, f));
      out.push({ path: `${folder}/${f}`, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function readResultFile(p) {
  const full = path.resolve(PROJECT, String(p || ""));
  const r = path.relative(PROJECT, full);
  if (r.startsWith("..") || path.isAbsolute(r) || !full.endsWith(".md")) return null;
  const top = r.split(path.sep)[0];
  if (!RESULT_FOLDERS.includes(top) || !fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

// ── 서버 ──────────────────────────────────────────────
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/skills.js": ["skills.js", "text/javascript; charset=utf-8"],
  "/skill-guide.js": ["skill-guide.js", "text/javascript; charset=utf-8"],
};
function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let b = "";
    req.on("data", d => { b += d; if (b.length > 200_000) { fail(new Error("too big")); req.destroy(); } });
    req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch (e) { fail(e); } });
  });
}

// ── 휴대폰·외부 접속 설정 ─────────────────────────────
const CONFIG_FILE = path.join(ROOT, "config.json");
async function remoteView(req) {
  return {
    mode: REMOTE.mode, port: PORT, platform: process.platform, isRemote: !!req.remoteUser, allowedEmails: REMOTE.allowedEmails,
    tailscale: req.remoteUser ? null : await remoteKit.tailscaleStatus(PORT),
    cloudflare: { ...remoteKit.cloudflareStatus(), publicHost: REMOTE.publicHost, accessTeam: REMOTE.accessTeam,
      hasAud: !!REMOTE.accessAud, hasToken: !!REMOTE.tunnelToken },
  };
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bareHost = v => String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
async function remoteAction(body) {
  const action = String(body.action || "");
  if (action === "off") {
    if (REMOTE.mode === "tailscale") await remoteKit.tailscaleOff(PORT);
    remoteKit.cloudflareStop();
    remoteKit.saveRemote(CONFIG_FILE, REMOTE, { mode: "off" });
    return { ok: true };
  }
  if (action === "tailscale-on") {
    const st = await remoteKit.tailscaleStatus(PORT);
    if (!st.installed) throw new Error("이 PC에 Tailscale이 없습니다. 1번부터 해 주세요.");
    if (!st.running) throw new Error("이 PC의 Tailscale 앱에서 로그인해 주세요.");
    const r = await remoteKit.tailscaleOn(PORT);
    if (r.consentUrl) return { consentUrl: r.consentUrl };
    remoteKit.cloudflareStop();
    // 이 PC에 로그인한 Tailscale 계정은 언제나 들어올 수 있게 한다
    const keep = REMOTE.mode === "tailscale" ? REMOTE.allowedEmails : [];
    const emails = [...new Set([st.login, ...keep].filter(Boolean))];
    remoteKit.saveRemote(CONFIG_FILE, REMOTE, { mode: "tailscale", tailscaleHost: st.host, allowedEmails: emails });
    return { ok: true, url: st.url };
  }
  if (action === "cloudflare-save") {
    const host = bareHost(body.publicHost), team = bareHost(body.accessTeam);
    const aud = String(body.accessAud || "").trim().toLowerCase() || REMOTE.accessAud; // 비우면 저장된 값 유지
    const token = String(body.tunnelToken || "").trim() || REMOTE.tunnelToken;
    const emails = String(body.allowedEmails || "").split(/[\s,]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new Error("내 주소를 skills.내도메인.com 처럼 적어 주세요.");
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) throw new Error("팀 주소는 이름.cloudflareaccess.com 모양이어야 합니다.");
    if (!/^[a-f0-9]{64}$/.test(aud)) throw new Error("AUD 태그는 64글자 영문·숫자입니다. Access 애플리케이션 화면에서 다시 복사해 주세요.");
    if (!token || token.length < 50) throw new Error("터널 토큰을 붙여 넣어 주세요.");
    if (!emails.length || !emails.every(e => EMAIL.test(e))) throw new Error("들어올 수 있는 이메일을 하나 이상 적어 주세요.");
    if (REMOTE.mode === "tailscale") await remoteKit.tailscaleOff(PORT);
    remoteKit.cloudflareStop();
    remoteKit.saveRemote(CONFIG_FILE, REMOTE, { mode: "cloudflare", publicHost: host, accessTeam: team, accessAud: aud, tunnelToken: token, allowedEmails: emails });
    jwks = { keys: [], at: 0 }; // 팀이 바뀌었을 수 있으니 서명 키를 다시 받는다
    remoteKit.cloudflareStart(token, path.join(ROOT, "logs"));
    return { ok: true, url: `https://${host}/` };
  }
  throw new Error("알 수 없는 요청입니다.");
}

const server = http.createServer(async (req, res) => {
  try {
    const denied = await checkRequest(req);
    if (denied) return json(res, 403, { error: denied });
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (req.method === "GET" && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      return res.end(fs.readFileSync(path.join(ROOT, "public", file)));
    }
    if (req.method === "GET" && p === "/brands.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(`const BRANDS = ${JSON.stringify(loadBrands())};\nconst CLAUDE_READY = ${!!claudePath()};\n`);
    }
    if (req.method === "POST" && p === "/api/run") {
      const body = await readBody(req);
      const skill = String(body.skill || "");
      const prompt = String(body.prompt || "");
      if (!/^[a-z0-9-]+$/.test(skill) || !prompt.startsWith(`/${skill} `)) return json(res, 400, { error: "스킬 정보가 올바르지 않습니다." });
      const j = { id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), skill,
        title: String(body.title || skill).slice(0, 120), prompt, status: "queued", createdAt: Date.now(),
        events: [], result: "", files: [], cost: null, clients: new Set() };
      jobs.set(j.id, j);
      queue.push(j);
      if (running) addEvent(j, "info", "앞 작업이 끝나면 시작합니다.");
      startNext();
      return json(res, 200, publicJob(j, false));
    }
    if (req.method === "GET" && p === "/api/jobs") {
      const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(j => publicJob(j, false));
      return json(res, 200, list);
    }
    let m = p.match(/^\/api\/jobs\/([a-z0-9]+)(\/events|\/cancel)?$/);
    if (m) {
      const j = jobs.get(m[1]);
      if (!j) return json(res, 404, { error: "작업을 찾을 수 없습니다." });
      if (!m[2] && req.method === "GET") return json(res, 200, publicJob(j, true));
      if (m[2] === "/cancel" && req.method === "POST") {
        if (j.status === "queued") { queue.splice(queue.indexOf(j), 1); setStatus(j, "canceled"); saveJob(j); }
        else if (j.status === "running") { setStatus(j, "canceled"); addEvent(j, "info", "작업을 취소했습니다."); killTree(j.pid); }
        return json(res, 200, publicJob(j, false));
      }
      if (m[2] === "/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.write(`event: state\ndata: ${JSON.stringify(publicJob(j, false))}\n\n`);
        for (const ev of j.events) res.write(`event: event\ndata: ${JSON.stringify(ev)}\n\n`);
        if (!["queued", "running"].includes(j.status)) {
          res.write(`event: result\ndata: ${JSON.stringify({ result: j.result, files: j.files, cost: j.cost })}\n\n`);
          return res.end();
        }
        j.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => { clearInterval(ping); j.clients.delete(res); });
        return;
      }
    }
    if (req.method === "GET" && p === "/api/setup") {
      return json(res, 200, await setupStatus({ claude: claudePath(), project: PROJECT, publicDir: path.join(ROOT, "public"), brands: loadBrands() }));
    }
    if (req.method === "POST" && p === "/api/setup") {
      const body = await readBody(req);
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      try { return json(res, 200, { brand: saveSetup(PROJECT, body, today) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === "GET" && p === "/api/update") return json(res, 200, await updater.check(url.searchParams.has("force")));
    if (req.method === "POST" && p === "/api/update") {
      // 실행 중인 작업이 있으면 서버를 끌 수 없으니 끝난 뒤에 하게 한다
      if (running || queue.length) return json(res, 409, { error: "실행 중인 작업이 끝난 뒤에 업데이트해 주세요." });
      try { const r = await updater.apply(); json(res, 200, r); }
      catch (e) { return json(res, 400, { error: e.message }); }
      // 설치 스크립트가 파일을 바꿀 수 있게 서버는 잠시 뒤 스스로 꺼진다
      console.log("업데이트를 위해 서버를 끕니다.");
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    if (p === "/api/remote") {
      if (req.method === "GET") return json(res, 200, await remoteView(req));
      // 접속 설정은 PC 앞에서만 바꾼다 (휴대폰에서 실수로 끄면 다시 켤 방법이 없다)
      if (req.method === "POST") {
        if (req.remoteUser) return json(res, 403, { error: "접속 설정은 PC에서만 바꿀 수 있습니다." });
        try { return json(res, 200, await remoteAction(await readBody(req))); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
    }
    if (req.method === "GET" && p === "/api/files") return json(res, 200, listFiles());
    if (req.method === "GET" && p === "/api/file") {
      const text = readResultFile(url.searchParams.get("p"));
      if (text == null) return json(res, 404, { error: "파일을 열 수 없습니다." });
      return json(res, 200, { path: url.searchParams.get("p"), text });
    }
    json(res, 404, { error: "없는 주소입니다." });
  } catch (e) {
    json(res, 500, { error: "서버 오류: " + e.message });
  }
});

loadJobs();
// 켜진 서버의 번호(PID)를 남긴다. stop/start 스크립트가 이 번호로 서버를 찾는다.
// netstat은 일부 Windows 판에서 대기 중인 포트를 빠뜨리거나 상태를 틀리게 보여 줘서 믿을 수 없다.
const PID_FILE = path.join(ROOT, "server.pid");
process.on("exit", () => {
  try { if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {}
});
server.listen(PORT, "127.0.0.1", () => {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  console.log(`마케팅 스킬 명령판: http://127.0.0.1:${PORT}`);
  console.log(`작업 폴더: ${PROJECT}`);
  console.log(CLAUDE ? `Claude Code: ${CLAUDE}` : "주의: Claude Code를 찾지 못했습니다. 설치 후 다시 켜 주세요.");
  if (REMOTE.mode === "cloudflare") {
    console.log(REMOTE.accessAud ? `외부 주소: https://${REMOTE.publicHost}` : "주의: remote.accessAud가 비어 있어 외부 접속은 모두 거절됩니다.");
    remoteKit.cloudflareStart(REMOTE.tunnelToken, path.join(ROOT, "logs"));
  }
  if (REMOTE.mode === "tailscale") console.log(`휴대폰 주소(Tailscale): https://${REMOTE.tailscaleHost}:${PORT}/`);
});
