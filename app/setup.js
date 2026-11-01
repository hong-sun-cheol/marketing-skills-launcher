// 첫 실행 준비: Claude 설치·로그인·스킬 확인, 사업 정보로 작업 폴더 기본 파일 만들기.
// 여기서는 Claude를 부르지 않는다. 틀에 채워 넣기만 하므로 비용이 들지 않는다.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const RESULT_DIRS = ["기획", "카피", "광고", "SEO", "이메일", "SNS", "분석", ".agents"];
const LIMITS = { short: 200, long: 2000 };

// ── 상태 확인 ─────────────────────────────────────────
function authStatus(claude) {
  return new Promise(ok => {
    if (!claude) return ok(null);
    execFile(claude, ["auth", "status"], { timeout: 20000, windowsHide: true }, (err, out) => {
      try {
        const j = JSON.parse(out);
        // 화면에는 꼭 필요한 것만 넘긴다 (조직 ID 등은 빼기)
        ok({ loggedIn: !!j.loggedIn, method: j.authMethod || "", plan: j.subscriptionType || "", email: j.email || "" });
      } catch { ok({ loggedIn: false, method: "", plan: "", email: "", error: err ? String(err.message).slice(0, 200) : "" }); }
    });
  });
}

// 화면의 스킬 목록(skills.js)에 있는 스킬이 깔려 있는지 센다.
// 설치 파일은 작업 폴더의 .claude/skills 에 깐다. 사용자가 PC 전체(~/.claude/skills)에 깔아 둔 것도 인정한다.
function skillStatus(publicDir, project) {
  const src = fs.readFileSync(path.join(publicDir, "skills.js"), "utf8");
  const ids = [...new Set([...src.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map(m => m[1]))];
  const bases = [path.join(project, ".claude", "skills"),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills")];
  const missing = ids.filter(id => !bases.some(b => fs.existsSync(path.join(b, id, "SKILL.md"))));
  return { total: ids.length, installed: ids.length - missing.length, missing };
}

async function setupStatus({ claude, project, publicDir, brands }) {
  const auth = await authStatus(claude);
  const withDocs = brands.map(b => ({ ...b, ready: fs.existsSync(path.join(project, b.doc)) }));
  return {
    claudeFound: !!claude,
    auth,
    skills: skillStatus(publicDir, project),
    workspace: project,
    brands: withDocs,
    ready: !!claude && !!auth?.loggedIn && withDocs.some(b => b.ready),
  };
}

// ── 사업 정보 저장 ────────────────────────────────────
const clean = (v, max, multi) => {
  let s = String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
  if (!multi) s = s.replace(/\s*\n\s*/g, " ");
  return s;
};
const orTodo = s => s || "확인 필요";

function marketingDoc(d) {
  const lines = s => s ? s.split("\n").map(x => x.trim()).filter(Boolean).map(x => `- ${x}`).join("\n") : "- 확인 필요";
  return `# Product Marketing Context

**Document version:** v1
**Last updated:** ${d.today}
**근거:** 마케팅 스킬 명령판 첫 실행 화면에서 사용자가 직접 입력한 내용. 입력하지 않은 항목은 "확인 필요"로 둔다.

## Product Overview
**이름:** ${d.name}
**한 줄 소개:** ${orTodo(d.what)}
**업종:** ${orTodo(d.industry)}
**지역:** ${orTodo(d.region)}
**대표 상품·가격:**
${lines(d.offer)}
**사이트·채널:** ${orTodo(d.site)}${d.channels ? `\n**지금 쓰는 홍보 채널:** ${d.channels}` : ""}

## Target Audience
**주요 고객:** ${orTodo(d.customers)}
**고객이 해결하고 싶은 일:** 확인 필요

## Problems & Pain Points
확인 필요

## Competitive Landscape
확인 필요. 특정 경쟁사 이름을 꺼내거나 비교 우위를 주장하지 않는다.

## Differentiation
**강점:**
${lines(d.strengths)}

## Customer Language
아직 수집된 고객 원문·후기 없음. 후기를 지어내거나 인용하지 않는다.

## Brand Voice
**말투:** ${orTodo(d.tone)}
**피할 표현:** ${orTodo(d.avoid)}

## Proof Points
아직 없음. 숫자·사례·후기는 근거가 생기면 추가한다.

## Goals
확인 필요

## Learnings
| Date | Learning | Evidence | Applies to | Status |
|------|----------|----------|------------|--------|
| | | | | |

## Changelog
- v1 (${d.today}) — 첫 실행 화면 입력으로 초안 작성.
`;
}

const WORKSPACE_RULES = `# 마케팅 작업실

마케팅 스킬 명령판이 쓰는 작업 폴더다. 기획·카피·광고·SEO·이메일·SNS·분석 결과를 여기에 모은다.

## 공통 맥락 파일
- 모든 마케팅 스킬은 \`.agents/brands.json\`에 등록된 브랜드 문서(\`.agents/product-marketing*.md\`)를 먼저 읽는다.
- 명령에 기준 브랜드가 적혀 있으면 그 문서를 쓴다. 문서가 없으면 \`product-marketing\` 스킬로 먼저 만든다.

## 일하는 방식
- 결과물은 한국어로 쓰고, 한국 채널(네이버 블로그, 인스타그램, 카카오 등)과 한국 독자 기준으로 바꿔 적용한다. 스킬 안의 예시는 대부분 미국 기준이다.
- 결과물은 주제별 폴더에 마크다운으로 저장한다: \`기획/\`, \`카피/\`, \`광고/\`, \`SEO/\`, \`이메일/\`, \`SNS/\`, \`분석/\`
- 파일 이름은 \`날짜_주제.md\` (예: \`2026-11-01_가을행사-카피.md\`)
- 숫자·사례·후기는 근거가 있는 것만 쓴다. 모르면 지어내지 말고 "확인 필요"로 표시한다.
- 이 폴더 밖의 파일은 읽거나 쓰지 않는다.
`;

function readBrands(project) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(project, ".agents", "brands.json"), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// 입력을 받아 브랜드 문서·브랜드 목록·작업 폴더 규칙을 만든다. 같은 이름이 있으면 그 문서를 새로 쓴다.
function saveSetup(project, body, today) {
  const d = {
    today,
    name: clean(body.name, 60),
    what: clean(body.what, LIMITS.short),
    industry: clean(body.industry, 60),
    region: clean(body.region, 60),
    customers: clean(body.customers, LIMITS.short),
    site: clean(body.site, LIMITS.short),
    channels: clean(body.channels, LIMITS.short),
    offer: clean(body.offer, LIMITS.long, true),
    strengths: clean(body.strengths, LIMITS.long, true),
    tone: clean(body.tone, 60),
    avoid: clean(body.avoid, LIMITS.short),
  };
  if (!d.name) throw new Error("사업(브랜드) 이름을 적어 주세요.");
  if (!d.what) throw new Error("무슨 일을 하는지 한 줄로 적어 주세요.");

  for (const dir of RESULT_DIRS) fs.mkdirSync(path.join(project, dir), { recursive: true });
  const rules = path.join(project, "CLAUDE.md");
  if (!fs.existsSync(rules)) fs.writeFileSync(rules, WORKSPACE_RULES);

  const brands = readBrands(project);
  let b = brands.find(x => x.name === d.name);
  if (!b) {
    const first = brands.length === 0;
    const key = first ? "main" : `b${Date.now().toString(36)}`;
    b = { key, name: d.name, doc: first ? ".agents/product-marketing.md" : `.agents/product-marketing-${key}.md`, site: "" };
    brands.push(b);
  }
  // "blog.naver.com/아이디"처럼 https:// 없이 적어도 주소로 쓴다. 여러 개면 첫 주소만.
  const url = d.site.split(/[\s,]+/)[0] || "";
  b.site = /^https?:\/\//i.test(url) ? url : /^[\w-]+(\.[\w-]+)+/.test(url) ? `https://${url}` : "";
  fs.writeFileSync(path.join(project, b.doc), marketingDoc(d));
  fs.writeFileSync(path.join(project, ".agents", "brands.json"), JSON.stringify(brands, null, 2));
  return b;
}

module.exports = { setupStatus, saveSetup };
