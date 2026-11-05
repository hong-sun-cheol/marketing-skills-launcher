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
  let repository = null, images = [], busy = false, connected = false, rows = [], page = 1, more = false, onChange = () => {};
  let githubState = null;
  const notify = () => { renderChosen(); onChange(); };
  async function action(fn, message) {
    if (busy) return;
    busy = true; onChange(); box.setAttribute("aria-busy", "true");
    msg.className = "status"; msg.textContent = message;
    box.querySelectorAll("button, input, select").forEach(n => { n.disabled = true; });
    try { await fn(); }
    catch (e) { msg.className = "status warn"; msg.textContent = e.message; }
    finally {
      busy = false; box.removeAttribute("aria-busy");
      box.querySelectorAll("button, input, select").forEach(n => { n.disabled = false; });
      notify();
    }
  }
  function renderChosen() {
    chosen.replaceChildren(...(repository ? [node("div", { class: "material-repo" },
      node("strong", { text: repository.label }),
      node("p", { class: "ds", text: `${repository.branch} · ${repository.commit.slice(0, 7)} · ${repository.warning}` }),
      button("선택한 코드 새로 받기", () => action(async () => { repository = await request("/api/github/import", { method: "POST", body: JSON.stringify({ repository: repository.repository }) }); msg.textContent = "최신 코드를 첨부했습니다."; }, "최신 코드를 불러오는 중…")),
      button("코드 첨부 제거", () => { if (!busy) { repository = null; notify(); } }))] : []));
    const refresh = chosen.querySelector("button");
    if (refresh) refresh.disabled = !connected || busy;
    uploads.replaceChildren(...images.map(m => node("figure", { class: "material-image" },
      node("a", { href: `/api/materials/${m.id}/image`, target: "_blank", rel: "noopener" }, node("img", { src: `/api/materials/${m.id}/image`, alt: m.label })),
      node("figcaption", { text: m.label }), button("이미지 제거", () => { if (!busy) { images = images.filter(i => i.id !== m.id); notify(); } }))));
  }
  async function loadRepos(reset = true) {
    const next = reset ? 1 : page + 1;
    const data = await request("/api/github/repos?page=" + next);
    rows = reset ? data.repos : [...rows, ...data.repos]; page = next; more = data.more;
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
    const search = node("input", { type: "search", placeholder: "저장소 이름으로 찾기", "aria-label": "저장소 검색" });
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      select.replaceChildren(node("option", { value: "", text: "분석할 저장소를 선택하세요" }),
        ...rows.filter(r => r.fullName.toLowerCase().includes(q)).map(r => node("option", { value: r.fullName, text: `${r.fullName}${r.private ? " (비공개)" : ""}` })));
    };
    search.addEventListener("input", fill); fill();
    githubBox.replaceChildren(node("strong", { text: `GitHub · ${githubState.login}` }),
      node("div", { class: "actions" }, button("저장소 목록 새로고침", () => action(async () => { await loadRepos(); msg.textContent = "목록을 새로 받았습니다."; }, "저장소 목록을 불러오는 중…")),
        button("연결 해제", () => action(async () => {
          await request("/api/github", { method: "DELETE" }); connected = false; repository = null; rows = []; renderGithub();
          msg.textContent = "GitHub 연결과 현재 코드 선택을 해제했습니다. 과거 분석 자료는 작업 폴더에 남습니다.";
        }, "연결을 해제하는 중…"))),
      search, select,
      node("div", { class: "actions" }, button("선택한 코드 첨부", () => {
        if (!select.value) { msg.className = "status warn"; msg.textContent = "먼저 저장소를 선택해 주세요."; return; }
        const name = select.value;
        action(async () => { repository = await request("/api/github/import", { method: "POST", body: JSON.stringify({ repository: name }) }); msg.textContent = "코드를 첨부했습니다. 아래 실행 버튼을 누르면 분석에 반영됩니다."; }, "코드를 불러오는 중… 파일 수에 따라 잠시 걸립니다.");
      }), more ? button("저장소 더 보기", () => action(async () => { await loadRepos(false); msg.textContent = `${rows.length}개 저장소를 불러왔습니다.`; }, "추가 저장소를 불러오는 중…")) : null),
      node("p", { class: "ds", text: "기본 브랜치의 주요 코드 최대 120개를 읽습니다. 큰 파일·설치 패키지·비밀 설정은 제외하며, 가져온 범위는 아래에 표시됩니다." }));
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
  return { mount: () => box, ids: () => [...(repository ? [repository.id] : []), ...images.map(m => m.id)],
    busy: () => busy, onChange: fn => { onChange = fn; },
    summary: () => [...(repository ? [`GitHub: ${repository.label} (${repository.warning})`] : []), ...images.map(m => `스크린샷: ${m.label}`)].join("\n") };
})();
