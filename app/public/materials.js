"use strict";
// 하나의 자료 영역을 재사용해 스킬 전환 중에도 첨부가 사라지지 않게 한다.
window.AnalysisMaterials = (() => {
  const node = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "text") n.textContent = value;
      else if (key.startsWith("on")) n.addEventListener(key.slice(2), value);
      else n.setAttribute(key, value);
    }
    children.flat().filter(c => c != null).forEach(c => n.append(c));
    return n;
  };
  async function request(url, options = {}) {
    const r = await fetch(url, { ...options, headers: { "content-type": "application/json", "x-runner": "1" } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "자료를 불러오지 못했습니다.");
    return data;
  }
  const button = (text, onclick) => node("button", { type: "button", class: "btn small", text, onclick });
  const box = node("section", { class: "materials", "aria-label": "분석 자료" });
  const msg = node("p", { class: "status", role: "status", "aria-live": "polite" });
  const githubBox = node("div", { class: "material-github" });
  const chosen = node("div", { class: "material-chosen" });
  const uploads = node("div", { class: "material-images" });
  let repositories = [], images = [], busy = false, connected = false, rows = [], page = 1, more = false, onChange = () => {};
  let listed = false;   // 저장소 목록을 한 번이라도 받았는지 (받기 전엔 고르는 칸이 비어 보인다)
  let instruction = "", discovery = "";
  let githubState = null;
  const notify = () => { renderChosen(); onChange(); };
  const fetchedAt = t => {
    if (!t) return "받은 시각 모름";
    const d = new Date(t), now = new Date(), hm = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    return (d.toDateString() === now.toDateString() ? "오늘 " : d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" }) + " ") + hm + "에 받은 코드";
  };
  // out: 진행·오류 글을 띄울 곳. 누른 버튼 바로 옆에 띄워야 반응이 있는지 알아볼 수 있다.
  async function action(fn, message, out = msg) {
    if (busy) return;
    busy = true; onChange(); box.setAttribute("aria-busy", "true");
    out.className = "status"; out.textContent = message;
    box.querySelectorAll("button, input, select, textarea").forEach(n => { n.disabled = true; });
    try { await fn(); }
    catch (e) { out.className = "status warn"; out.textContent = e.message; }
    finally {
      busy = false; box.removeAttribute("aria-busy");
      box.querySelectorAll("button, input, select, textarea").forEach(n => { n.disabled = false; });
      notify();
    }
  }
  function renderChosen() {
    chosen.replaceChildren(...repositories.map(repository => node("div", { class: "material-repo" },
      node("strong", { text: repository.label }),
      // 첨부는 받은 순간의 복사본이다. 언제 받았는지 보여야 '다시 받기'가 필요한지 판단할 수 있다.
      node("p", { class: "ds", text: `${fetchedAt(repository.createdAt)} · ${repository.branch} · ${repository.commit.slice(0, 7)} · ${repository.warning}` }),
      repository.sourceNote ? node("p", { class: "ds", text: "포함한 이유: " + repository.sourceNote }) : null,
      node("div", { class: "actions" },
        button("GitHub 최신 코드로 다시 받기", () => action(async () => { const fresh = await request("/api/github/import", { method: "POST", body: JSON.stringify({ repository: repository.repository }) }); repositories = repositories.map(r => r.id === repository.id ? { ...fresh, sourceNote: fresh.sourceNote || repository.sourceNote, found: repository.found } : r); msg.textContent = "최신 코드를 첨부했습니다."; }, "최신 코드를 불러오는 중…")),
        button("코드 첨부 제거", () => { if (!busy) { repositories = repositories.filter(r => r.id !== repository.id); notify(); } })),
      node("p", { class: "ds", text: "첨부 뒤 GitHub 코드를 고쳐 올렸을 때만 누르세요. 첨부하고 바로 실행할 때는 필요 없습니다." }))));
    chosen.querySelectorAll(".material-repo").forEach(row => { row.querySelector("button").disabled = !connected || busy; });
    uploads.replaceChildren(...images.map(m => node("figure", { class: "material-image" },
      node("a", { href: `/api/materials/${m.id}/image`, target: "_blank", rel: "noopener" }, node("img", { src: `/api/materials/${m.id}/image`, alt: m.label })),
      node("figcaption", { text: m.label }), button("이미지 제거", () => { if (!busy) { images = images.filter(i => i.id !== m.id); notify(); } }))));
  }
  async function loadRepos(reset = true) {
    const next = reset ? 1 : page + 1;
    const data = await request("/api/github/repos?page=" + next);
    rows = reset ? data.repos : [...rows, ...data.repos]; page = next; more = data.more; listed = true;
    renderGithub();
  }
  function renderGithub() {
    if (!connected) {
      const token = node("input", { id: "githubToken", type: "password", autocomplete: "off", placeholder: "GitHub에서 만든 연결 키 붙여 넣기" });
      const connect = mode => action(async () => {
        const secret = token.value;
        token.value = "";
        githubState = await request("/api/github", { method: "POST", body: JSON.stringify({ mode, ...(mode === "token" ? { token: secret } : {}) }) });
        connected = true; renderGithub();
        await loadRepos(); msg.textContent = "연결했습니다. 분석할 저장소를 선택해 주세요.";
      }, "GitHub 연결을 확인하는 중…");
      githubBox.replaceChildren(node("strong", { text: "GitHub 코드" }),
        node("p", { class: "ds", text: "내 저장소 또는 공동 작업 중인 저장소를 골라 기존 분석에 함께 사용합니다." }),
        button("이 PC의 GitHub 계정 연결", () => connect("cli")),
        node("details", {}, node("summary", { text: "처음 연결하거나 다른 계정으로 연결하기" }),
          node("p", { class: "ds", text: "GitHub 연결 키를 만들 때 분석할 저장소만 선택하고 Contents를 Read-only(읽기 전용)로 허용하세요. 연결 키는 이 PC의 앱 설정에 저장됩니다." }),
          node("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener", text: "GitHub에서 연결 키 만들기" }),
          node("label", { for: "githubToken", text: "연결 키" }), token, button("연결 키로 연결", () => connect("token")),
          node("p", { class: "ds", text: "공동 작업·조직 저장소가 안 보이면 GitHub에서 해당 저장소 접근 권한과 조직 승인을 확인해 주세요. 이미 GitHub CLI에 로그인했다면 위의 PC 계정 연결을 쓸 수 있습니다." })));
      return;
    }
    const select = node("select", { id: "githubRepo", "aria-label": "분석할 GitHub 저장소" });
    // 검색칸은 따로 쓰는 칸이 아니라 바로 밑 목록을 좁히는 칸이다. 몇 개 남았는지 목록 첫 줄에 보여 연결을 드러낸다.
    const search = node("input", { type: "search", placeholder: "아래 목록에서 이름으로 좁히기", "aria-label": "아래 저장소 목록을 이름으로 좁히기" });
    const fill = () => {
      const raw = search.value.trim(), q = raw.toLowerCase();
      const shown = rows.filter(r => r.fullName.toLowerCase().includes(q));
      const first = !listed ? "저장소 목록을 불러오는 중…" : !rows.length ? "보이는 저장소가 없습니다"
        : !raw ? "분석할 저장소를 선택하세요" : shown.length ? `'${raw}'이(가) 들어간 저장소 ${shown.length}개 — 선택하세요` : `'${raw}'이(가) 들어간 저장소가 없습니다`;
      select.replaceChildren(node("option", { value: "", text: first }),
        ...shown.map(r => node("option", { value: r.fullName, text: `${r.fullName}${r.private ? " (비공개)" : ""}` })));
    };
    search.addEventListener("input", fill); fill();
    const attachNote = node("p", { class: "status", role: "status", "aria-live": "polite" });
    githubBox.replaceChildren(node("strong", { text: `GitHub · ${githubState.login}` }),
      node("div", { class: "actions" }, button("저장소 목록 새로고침", () => action(async () => { await loadRepos(); msg.textContent = "목록을 새로 받았습니다."; }, "저장소 목록을 불러오는 중…")),
        button("연결 해제", () => action(async () => {
          await request("/api/github", { method: "DELETE" }); connected = false; listed = false; repositories = []; rows = []; discovery = ""; renderGithub();
          msg.textContent = "GitHub 연결과 현재 코드 선택을 해제했습니다. 과거 분석 자료는 작업 폴더에 남습니다.";
        }, "연결을 해제하는 중…"))),
      node("div", { class: "material-pick" }, search, select),
      node("div", { class: "actions" }, button("선택한 코드 첨부", () => {
        if (!select.value) {
          attachNote.className = "status warn";
          attachNote.textContent = listed ? "먼저 위 칸에서 저장소를 선택해 주세요." : "저장소 목록을 불러오는 중입니다. 잠시 뒤 저장소를 고르고 다시 눌러 주세요.";
          return;
        }
        const name = select.value;
        action(async () => {
          if (repositories.length >= 5 && !repositories.some(r => r.repository.toLowerCase() === name.toLowerCase())) throw new Error("저장소는 최대 5개까지 함께 첨부할 수 있습니다.");
          const repository = await request("/api/github/import", { method: "POST", body: JSON.stringify({ repository: name }) });
          repositories = [...repositories.filter(r => r.repository.toLowerCase() !== name.toLowerCase()), repository];
          attachNote.textContent = `${name} 코드를 첨부했습니다(아래 목록). 다른 저장소도 이어서 선택해 함께 넣을 수 있습니다.`;
        }, "코드를 불러오는 중… 파일 수에 따라 잠시 걸립니다.", attachNote);
      }), more ? button("저장소 더 보기", () => action(async () => { await loadRepos(false); msg.textContent = `${rows.length}개 저장소를 불러왔습니다.`; }, "추가 저장소를 불러오는 중…")) : null),
      attachNote,
      node("p", { class: "ds", text: "저장소 최대 5개를 함께 첨부합니다. 각 저장소 기본 브랜치의 주요 코드 최대 120개를 읽으며, 가져온 범위는 아래에 표시됩니다." }));
    const input = node("textarea", { id: "relatedCodeRequest", maxlength: "2000", placeholder: "예: eflipsolution을 분석에 넣고 싶어. GitHub 저장소의 코드를 살펴보고 관련 서버 코드도 있으면 함께 넣어 줘." });
    input.value = instruction;
    input.addEventListener("input", () => { instruction = input.value; });
    const report = node("p", { class: "ds", role: "status", style: "white-space:pre-wrap", text: discovery });
    const finder = node("div", { class: "material-finder" },
      node("label", { for: "relatedCodeRequest", text: "Claude에게 관련 코드 찾기 요청" }), input,
      // 버튼은 입력창 바로 밑, 그 밑에 진행·결과(report), 설명은 맨 아래
      button("관련 코드 찾아서 첨부", () => action(async () => {
        if (!instruction.trim()) throw new Error("찾을 사이트 이름과 관련 코드에 대한 요청을 적어 주세요.");
        const found = await request("/api/github/discover", { method: "POST", body: JSON.stringify({ instruction }) });
        // 새로 찾으면 지난 찾기 결과(found)는 새 결과로 바꾸고, 직접 고른 저장소는 남긴다.
        // 아무것도 못 찾으면 지난 결과를 지우지 않는다.
        const kept = found.materials.length ? repositories.filter(r => !r.found) : repositories;
        const replaced = repositories.length - kept.length;
        const combined = new Map(kept.map(r => [r.repository.toLowerCase(), r]));
        const skipped = [];
        for (const m of found.materials) {
          if (combined.size >= 5 && !combined.has(m.repository.toLowerCase())) { skipped.push(m.repository); continue; }
          combined.set(m.repository.toLowerCase(), { ...m, found: true });
        }
        repositories = [...combined.values()];
        const head = found.materials.length
          ? `관련 코드 찾기를 마쳤습니다.${replaced ? ` 지난 찾기 결과 ${replaced}개는 이번 결과로 바꿨습니다.` : ""} 현재 ${repositories.length}개 저장소가 첨부되어 있습니다(아래 목록).`
          : "새로 찾은 저장소가 없어 지금 첨부는 그대로 둡니다. 아래 찾기 결과를 확인해 주세요.";
        discovery = [head, found.message, ...found.warnings, ...(skipped.length ? ["첨부 한도 때문에 제외됨: " + skipped.join(", ") + ". 기존 첨부를 제거한 뒤 다시 요청해 주세요."] : [])].join("\n");
        report.textContent = discovery;
      }, "Claude가 저장소와 코드 연결을 확인하는 중… 몇 분 걸릴 수 있습니다.", report)), report,
      node("p", { class: "ds", text: "사이트 이름과 원하는 코드 범위만 적으세요. Claude가 저장소 목록과 주요 코드의 연결 관계를 살펴보고 관련 코드를 자동 첨부합니다. 이 단계에도 Claude 계정 사용량이 발생합니다." }));
    githubBox.append(finder);
    if (busy) githubBox.querySelectorAll("button, input, select, textarea").forEach(n => { n.disabled = true; });
  }
  async function uploadFiles(list) {
    if (busy || !list.length) return;
    await action(async () => {
      if (images.length + list.length > 6) throw new Error("스크린샷은 한 번에 최대 6장까지 첨부할 수 있습니다.");
      for (const f of list) {
        if (!/^image\/(png|jpeg|webp)$/.test(f.type) || f.size > 8 * 1024 * 1024 || !f.size) throw new Error("PNG, JPG, WebP 파일만 한 장에 8MB까지 첨부할 수 있습니다.");
      }
      for (const f of list) {
        // 브라우저에서 실제로 열리는 이미지만 전달한다.
        const bitmap = await createImageBitmap(f).catch(() => { throw new Error(`${f.name}: 이미지가 손상되어 열 수 없습니다.`); });
        bitmap.close();
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다.")); reader.readAsDataURL(f); });
        images.push(await request("/api/materials/images", { method: "POST", body: JSON.stringify({ name: f.name, data }) }));
      }
      msg.textContent = "스크린샷을 첨부했습니다. 실행하면 이미지 속 통계도 함께 읽습니다.";
    }, "스크린샷을 올리는 중…");
  }
  const input = node("input", { id: "analysisImages", type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "", onchange: async e => { const files = Array.from(e.target.files); e.target.value = ""; await uploadFiles(files); } });
  const drop = node("div", { class: "material-drop", tabindex: "0", "aria-label": "스크린샷을 놓거나 붙여넣는 영역" },
    node("label", { for: "analysisImages", text: "스크린샷 첨부" }), input,
    node("p", { class: "ds", text: "블로그 통계 등을 골라 올리거나 여기에 끌어 놓으세요. 이 영역을 누른 뒤 Ctrl+V(Mac: ⌘V)로 붙여 넣을 수도 있습니다. PNG·JPG·WebP, 장당 8MB, 최대 6장." }));
  drop.addEventListener("dragover", e => { e.preventDefault(); });
  drop.addEventListener("drop", e => { e.preventDefault(); uploadFiles(Array.from(e.dataTransfer.files)); });
  drop.addEventListener("paste", e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); uploadFiles(files); } });
  box.append(node("h3", { text: "분석 자료 (선택)" }), node("p", { class: "ds", text: "첨부한 코드와 이미지를 현재 스킬에 함께 전달합니다. 다른 스킬을 골라도 첨부는 유지되며, 제거하거나 화면을 새로 고치면 선택이 비워집니다." }), githubBox, chosen, drop, uploads, msg);
  async function init() {
    try {
      githubState = await request("/api/github"); connected = githubState.connected; renderGithub();
      if (connected) await loadRepos();
    } catch (e) { githubBox.replaceChildren(node("p", { class: "status warn", text: e.message }), button("다시 확인", init)); }
  }
  init();
  return { mount: () => box, ids: () => [...repositories.map(m => m.id), ...images.map(m => m.id)],
    busy: () => busy, onChange: fn => { onChange = fn; },
    summary: () => [...repositories.map(r => `GitHub: ${r.label} (${r.warning})`), ...images.map(m => `스크린샷: ${m.label}`)].join("\n") };
})();
