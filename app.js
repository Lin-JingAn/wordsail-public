import { buildRevisionSentence, catalogStats, dueWordIds, updateProgress, weakWordsStudiedOn } from "./learning-core.js";
import { universityMottos } from "./motto-catalog.js";
import { VoiceAIClient } from "./voice-ai.js";
import { createCloudSync } from "./cloud-sync.js";

const STORAGE_KEY = "aster-english-state-v1";
const SESSION_KEY = "wordsail-session-v1";
const WELCOME_KEY = "wordsail-welcome-v1";
const app = document.getElementById("app");
let voiceClient = null;
let cloudSync = null;

function apiEndpoint(pathname) {
  const base = String(globalThis.WORDSAIL_CONFIG?.apiBase || "").replace(/\/$/, "");
  return base ? `${base}${pathname}` : pathname;
}

const state = {
  page: location.hash.slice(1) || "home",
  catalog: null,
  activeChapterId: "",
  query: "",
  session: [],
  sessionIndex: 0,
  revealed: false,
  progress: {},
  activityDates: [],
  localUpdatedAt: "",
  cloud: { mode: "disabled", detail: "", enabled: false, userId: "" },
  toastTimer: null,
  mottoTimer: null,
  mottoIndex: Math.floor(Date.now() / 86400000) % universityMottos.length,
  overlay: null,
  feedbackRating: 0,
  feedbackSending: false,
  voiceStatus: { configured: false, loading: true, authMode: "missing" },
  speaking: {
    screen: "lobby",
    mode: "weak",
    persona: "gentle",
    pace: "slow",
    seconds: 0,
    timer: null,
    micOn: true,
    subtitlesOn: true,
    promptIndex: 0,
    hintVisible: false,
    live: false,
    phase: "idle",
    error: "",
    userText: "",
    assistantText: "",
    transcript: []
  }
};

function loadLocalState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.progress = saved.progress && typeof saved.progress === "object" ? saved.progress : {};
    state.activityDates = Array.isArray(saved.activityDates) ? saved.activityDates : [];
    state.activeChapterId = String(saved.activeChapterId || "");
    state.localUpdatedAt = String(saved.updatedAt || "");
  } catch { /* Ignore damaged local state. */ }
}

function learningSnapshot() {
  return {
    progress: state.progress,
    activityDates: state.activityDates,
    activeChapterId: state.activeChapterId,
    updatedAt: state.localUpdatedAt || new Date().toISOString(),
    schemaVersion: 1
  };
}

function saveLocalState(syncCloud = true) {
  state.localUpdatedAt = new Date().toISOString();
  const snapshot = learningSnapshot();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  if (syncCloud) cloudSync?.saveLearningState(snapshot);
}

function applyCloudSnapshot(snapshot) {
  state.progress = snapshot.progress || {};
  state.activityDates = Array.isArray(snapshot.activityDates) ? snapshot.activityDates : [];
  state.activeChapterId = String(snapshot.activeChapterId || state.activeChapterId || "");
  state.localUpdatedAt = String(snapshot.updatedAt || new Date().toISOString());
  localStorage.setItem(STORAGE_KEY, JSON.stringify(learningSnapshot()));
  if (state.catalog) render();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function sessionId() {
  let value = localStorage.getItem(SESSION_KEY);
  if (!value) {
    value = globalThis.crypto?.randomUUID?.() || `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(SESSION_KEY, value);
  }
  return value;
}

function trackEvent(event, properties = {}) {
  const payload = { event, properties, sessionId: sessionId(), page: state.page, createdAt: new Date().toISOString() };
  if (cloudSync?.enabled) {
    cloudSync.recordEvent(payload);
    return;
  }
  fetch(apiEndpoint("/api/events"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {});
}

function todayLabel() {
  return new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function allWords() {
  return state.catalog?.chapters.flatMap(chapter => chapter.words || []) || [];
}

function activeChapter() {
  return state.catalog?.chapters.find(chapter => chapter.id === state.activeChapterId)
    || state.catalog?.chapters.find(chapter => chapter.words?.length)
    || state.catalog?.chapters[0];
}

function currentWord() {
  return state.session[state.sessionIndex] || null;
}

function sourceLabel() {
  if (state.catalog?.publicationReady) return "✓ 原创发布数据";
  return "仅本机 · 私人参考数据";
}

function sourceClass() {
  return state.catalog?.publicationReady ? "original" : "";
}

function cloudStatus() {
  const labels = {
    disabled: "◌ 本机保存",
    connecting: "⟳ 正在连接云端",
    synced: "☁ 云端已保存",
    queued: "☁ 等待同步",
    error: "⚠ 本机已保存"
  };
  return labels[state.cloud.mode] || labels.disabled;
}

function navButton(id, icon, label) {
  return `<button class="${state.page === id ? "active" : ""}" data-page="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`;
}

function globalFooter() {
  return `<footer class="product-footer"><span>词舟 WordSail · 雅思学习内测版</span><div><button data-action="open-feedback">体验反馈</button><button data-action="open-policy">隐私与版权</button></div></footer>`;
}

function overlay() {
  if (!state.overlay) return "";
  if (state.overlay === "welcome") return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title"><section class="overlay-card welcome-card">
    <small class="beta-label">WORDSAIL BETA · 首批体验</small><h2 id="welcome-title">把背过的词，慢慢变成你会说的话。</h2>
    <p>词舟把十词学习、间隔复习和 AI 口语练习连成一条路径。第一版不要求注册，三分钟就能完成第一次体验。</p>
    <div class="welcome-path"><span><b>01</b> 学一组词</span><i>→</i><span><b>02</b> 留下记忆</span><i>→</i><span><b>03</b> 开口表达</span></div>
    <div class="overlay-actions"><button class="btn primary" data-action="start-first-voyage">开始第一次学习</button><button class="btn outline" data-action="dismiss-welcome">先自己看看</button></div>
    <small class="privacy-note">学习进度会先保存在当前浏览器；云端连接后自动同步。内测期间记录匿名使用行为，用于改进产品。</small>
  </section></div>`;
  if (state.overlay === "feedback") return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="feedback-title"><section class="overlay-card feedback-card">
    <button class="overlay-close" data-action="close-overlay" aria-label="关闭">×</button><small class="beta-label">HELP US STEER · 帮词舟校准方向</small><h2 id="feedback-title">这次体验，离“愿意继续用”还有多远？</h2>
    <form id="feedback-form"><label>体验评分</label><div class="rating-row">${[1,2,3,4,5].map(value => `<button type="button" class="${state.feedbackRating === value ? "active" : ""}" data-feedback-rating="${value}">${value}<small>${value === 1 ? "不会再用" : value === 5 ? "愿意继续" : ""}</small></button>`).join("")}</div>
      <label for="feedback-message">最想让我们改进什么？</label><textarea id="feedback-message" name="message" maxlength="1200" placeholder="例如：我不知道下一步该点哪里；口语问题太难；我希望加入……" required></textarea>
      <label for="feedback-contact">方便回访的联系方式（选填）</label><input id="feedback-contact" name="contact" maxlength="160" placeholder="邮箱、小红书号或其他你愿意留下的方式">
      <button class="btn primary feedback-submit" type="submit" ${state.feedbackSending ? "disabled" : ""}>${state.feedbackSending ? "正在送出…" : "提交反馈"}</button>
    </form><small class="privacy-note">联系方式仅用于本次产品回访，不公开展示；你也可以完全匿名提交。</small>
  </section></div>`;
  if (state.overlay === "account") return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="account-title"><section class="overlay-card account-card">
    <button class="overlay-close" data-action="close-overlay" aria-label="关闭">×</button><small class="beta-label">CLOUD VOYAGE · 云端学习档案</small><h2 id="account-title">${state.cloud.mode === "synced" ? "这台设备的进度已经存入云端。" : "先保存在本机，接通后自动驶向云端。"}</h2>
    ${state.cloud.enabled
      ? `<p>词舟已创建匿名云端身份，学习进度、反馈和匿名产品事件会自动同步。即使临时断网，也会先留在本机，恢复后补传。</p><div class="account-state"><span>当前状态</span><strong>${esc(cloudStatus())}</strong></div><p class="account-note">匿名身份能防止本机数据丢失；要在另一台电脑或未来的小程序继续同一份进度，还需要绑定邮箱、手机号或微信。绑定入口会在云环境联调后开启。</p>`
      : `<p>云同步代码已经接入，但公开版本还缺一个 CloudBase 环境 ID，所以现在仍只保存在当前浏览器。创建环境后填入 ID，不需要把任何私钥放进网页。</p><div class="account-state"><span>当前状态</span><strong>等待云环境配置</strong></div><p class="account-note">连接完成后将同步：每个词的掌握度与复习日期、学习日期、当前章节、体验反馈及匿名运营事件。</p>`}
    ${state.cloud.detail ? `<small class="privacy-note">最近一次连接信息：${esc(state.cloud.detail)}</small>` : ""}
    <div class="overlay-actions"><button class="btn primary" data-action="close-overlay">我知道了</button><button class="btn outline" data-action="open-policy">查看隐私说明</button></div>
  </section></div>`;
  return `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="policy-title"><section class="overlay-card policy-card">
    <button class="overlay-close" data-action="close-overlay" aria-label="关闭">×</button><small class="beta-label">PUBLIC BETA · 公开内测说明</small><h2 id="policy-title">隐私、内容与版权</h2>
    <h3>我们记录什么</h3><p>为了安排复习和判断产品是否真正有用，词舟记录学习进度、匿名页面访问、开始学习、口语体验和主动提交的评分。云端未连接时，数据只保存在当前浏览器。</p>
    <h3>你主动填写的信息</h3><p>反馈和选填的联系方式只用于改进产品与体验回访，不用于出售或公开展示。</p>
    <h3>内容与商标说明</h3><p>公开版本只使用可发布的原创体验词条。学校名称和校训用于信息展示；词舟与 IELTS、Cambridge、British Council、IDP 及所展示院校不存在官方隶属或授权关系。</p>
    <div class="overlay-actions"><button class="btn primary" data-action="close-overlay">我知道了</button><button class="btn outline" data-action="open-feedback">提交建议</button></div>
  </section></div>`;
}

function shell(pageHtml) {
  const stats = catalogStats(state.catalog?.chapters || [], state.progress);
  const streak = Math.max(1, state.activityDates.length);
  return `<div class="shell">
    <aside class="side">
      <div class="brand"><div class="brand-mark">舟</div><div class="brand-copy">词舟<small>WORDSAIL ENGLISH</small></div></div>
      <div class="nav-label">LEARNING SPACE</div>
      <nav class="nav">
        ${navButton("home", "⌂", "学习主页")}
        ${navButton("library", "▤", "词汇图谱")}
        ${navButton("study", "✦", "开始学习")}
        ${navButton("speaking", "◉", "口语舱")}
        ${navButton("progress", "↗", "学习进度")}
      </nav>
      <div class="side-goal"><small>YOUR WORDSAIL JOURNEY</small><strong>${stats.average}% 掌握度</strong><p>以词为舟，去更远的世界。</p><div class="meter"><i style="width:${stats.average}%"></i></div></div>
    </aside>
    <div class="workspace">
      <div class="topbar"><span>${todayLabel()}</span><div class="top-actions"><button class="cloud-pill ${esc(state.cloud.mode)}" data-action="open-account">${cloudStatus()}</button><span class="source-pill ${sourceClass()}">${sourceLabel()}</span><span class="streak-pill">🔥 ${streak} 天学习记录</span></div></div>
      <main>${pageHtml}</main>
      ${globalFooter()}
    </div>
    <button class="feedback-fab" data-action="open-feedback"><span>✦</span> 体验反馈</button>
    <div class="toast" id="toast"></div>
    ${overlay()}
  </div>`;
}

function pageHeading(kicker, title, description) {
  return `<header class="page-heading"><div class="kicker">${kicker}</div><h1>${title}</h1><p>${description}</p></header>`;
}

function mottoHeading() {
  const motto = universityMottos[state.mottoIndex];
  const position = String(state.mottoIndex + 1).padStart(3, "0");
  const total = String(universityMottos.length).padStart(3, "0");
  const badge = motto.rank ? `QS 2027 · #${motto.rank}` : motto.group;
  const isInternational = motto.group === "QS 2027 · 海外前200";
  const headline = isInternational ? (motto.translation || motto.original) : motto.display;
  const chineseLine = isInternational ? motto.display : "";
  const longClass = String(headline).length > 68 ? " motto-long" : "";
  return `<header class="page-heading motto-heading${longClass}">
    <div class="motto-meta"><div class="kicker">DAILY CAMPUS MOTTO</div><div class="motto-controls"><button data-action="motto-prev" aria-label="上一条校训">←</button><span>${position} / ${total}</span><button data-action="motto-next" aria-label="下一条校训">→</button></div></div>
    <div class="motto-school"><span>${esc(motto.short)}</span>${esc(motto.school)} · ${esc(badge)} · ${esc(motto.theme)}</div>
    <h1>${esc(headline)}</h1>
    ${chineseLine ? `<p><em>${esc(chineseLine)}</em></p>` : ""}
    <div class="motto-timeline"><i></i></div>
  </header>`;
}

function yesterday() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date;
}

function weakWordStory() {
  const words = allWords();
  let selected = weakWordsStudiedOn(words, state.progress, yesterday(), 3);
  let isPersonal = selected.length > 0;
  if (!selected.length) {
    selected = words
      .filter(word => state.progress[word.id]?.attempts)
      .sort((left, right) => Number(state.progress[left.id]?.mastery || 0) - Number(state.progress[right.id]?.mastery || 0))
      .slice(0, 3);
  }
  if (!selected.length) selected = (activeChapter()?.words || []).slice(0, 3);
  return { selected, sentence: buildRevisionSentence(selected.map(word => word.term)), isPersonal };
}

function statCard(label, value, hint) {
  return `<div class="stat"><small>${label}</small><strong>${value}</strong><span>${hint}</span></div>`;
}

function homePage() {
  const words = allWords();
  const chapter = activeChapter();
  const stats = catalogStats(state.catalog.chapters, state.progress);
  const due = dueWordIds(state.progress).length;
  const story = weakWordStory();
  return `<section class="page">
    ${mottoHeading()}
    <section class="hero">
      <div class="hero-copy"><small>${story.isPersonal ? "YESTERDAY'S WEAK WORDS · 昨日薄弱词" : `FIRST VOYAGE · ${esc(chapter?.title || "VOCABULARY")}`}</small><h2 class="personal-sentence">${esc(story.sentence.english)}</h2><p>${esc(story.sentence.chinese)}${story.isPersonal ? " 这句话来自你昨天掌握度最低的词。" : " 完成今天的学习后，明天这里会出现你的专属句子。"}</p><div class="hero-actions"><button class="btn primary" data-action="quick-start">开始 10 词学习</button><button class="btn ghost" data-page="library">先看看词库</button></div></div>
      <article class="hero-card weak-word-card"><small>WORDS TO REVISIT</small><div class="weak-word-list">${story.selected.map(word => `<span>${esc(word.term)}<small>${state.progress[word.id]?.mastery ?? 0}%</small></span>`).join("")}</div><div class="mini-line"></div><blockquote>${story.isPersonal ? "不是重复昨天，而是把昨天模糊的地方，变成今天清晰的表达。" : "今天留下真实的学习记录，明天的词舟会更懂你。"}</blockquote></article>
    </section>
    <section class="speaking-promo">
      <div class="speaking-promo-mark"><span></span><span></span><span></span><span></span><span></span></div>
      <div><small>WORDSAIL SPEAKING CABIN</small><h2>今晚，要不要说十分钟英语？</h2><p>不必等谁，也不必害怕停顿。把今天学过的词，慢慢说成自己的表达。</p></div>
      <button class="btn primary" data-page="speaking">进入口语舱</button>
    </section>
    <div class="section-head"><h2>你的学习脉搏</h2><button data-page="progress">查看完整进度 →</button></div>
    <section class="stat-grid">
      ${statCard("当前可用词条", stats.total, state.catalog.publicationReady ? "原创发布数据" : "本机参考数据")}
      ${statCard("已经学习", stats.studied, `还剩 ${Math.max(0, stats.total - stats.studied)} 个未开始`)}
      ${statCard("掌握词汇", stats.mastered, "掌握度达到 80%")}
      ${statCard("今日到期", due, due ? "优先复习到期词" : "暂无到期任务")}
    </section>
    <div class="section-head"><h2>今天可以怎么学</h2></div>
    <section class="task-grid">
      <article class="task-card card"><span class="task-index">01</span><h3>顺序建立词感</h3><p>从当前词集开始，每次只处理十个词，保持清晰的完成感。</p><button class="round-action" data-action="quick-start">→</button></article>
      <article class="task-card card"><span class="task-index">02</span><h3>复习到期词</h3><p>${due ? `${due} 个词已经到达复习时间。` : "完成学习后，系统会按间隔自动安排。"}</p><button class="round-action" data-action="review-due" ${due ? "" : "disabled"}>→</button></article>
      <article class="task-card card"><span class="task-index">03</span><h3>探索词汇关系</h3><p>用搜索、搭配和词形找到单词之间真正有用的连接。</p><button class="round-action" data-page="library">→</button></article>
    </section>
  </section>`;
}

const speakingModes = {
  weak: {
    eyebrow: "WEAK WORD CHALLENGE",
    title: "弱词挑战",
    description: "把最近模糊的词放进自然对话，不再停留在认识它。",
    prompts: [
      "Let’s take it slowly. Could you describe a place whose atmosphere stayed in your memory?",
      "What made that atmosphere special to you?",
      "If you returned there tomorrow, what would you notice first?"
    ]
  },
  free: {
    eyebrow: "A QUIET CONVERSATION",
    title: "自由陪练",
    description: "从今天的心情开始，像朋友一样聊一会儿。",
    prompts: [
      "How has your day been so far? Take your time.",
      "Was there one small moment that made you feel better?",
      "What would make tomorrow a good day for you?"
    ]
  },
  mock: {
    eyebrow: "IELTS SPEAKING",
    title: "雅思模考",
    description: "按照 Part 1、2、3 的节奏完成一次安静的模拟。",
    prompts: [
      "Let’s talk about your hometown. What do you like most about it?",
      "Has your hometown changed much in recent years?",
      "Why do some people prefer to live away from where they grew up?"
    ]
  }
};

const personaLabels = { gentle: "温柔陪伴", friend: "真实朋友", examiner: "沉静考官" };
const paceLabels = { slow: "慢慢说", natural: "真实通话" };

function speakingWordList() {
  const story = weakWordStory();
  return story.selected.length ? story.selected.slice(0, 3) : [
    { term: "atmosphere" }, { term: "perspective" }, { term: "inevitable" }
  ];
}

function speakingLobby() {
  const speaking = state.speaking;
  const words = speakingWordList();
  const voiceReady = state.voiceStatus.configured;
  return `<section class="page speaking-page">
    ${pageHeading("WORDSAIL SPEAKING CABIN", "不必等谁，开口就是出发。", "这里允许停顿、重来和暂时想不起某个词。第一版先确认通话体验，接入语音服务后，词舟会真正听见并回应你。")}
    <section class="cabin-intro">
      <div class="cabin-intro-copy"><small>TONIGHT'S VOYAGE</small><h2>今晚想怎么开口？</h2><p>先选一种方式。没有准备好也没关系，词舟会从一个很轻的问题开始。</p></div>
      <div class="cabin-ready ${voiceReady ? "live-ready" : ""}"><i></i><span>${voiceReady ? "真实语音已就绪" : "等待语音配置"}</span><small>${voiceReady ? "豆包实时语音 · 麦克风通话" : "配置前仍可体验交互演示"}</small></div>
    </section>
    <div class="section-head"><h2>选择练习方式</h2><span class="section-note">一次只做一件事</span></div>
    <section class="speaking-mode-grid">
      ${Object.entries(speakingModes).map(([id, mode], index) => `<button class="speaking-mode ${speaking.mode === id ? "selected" : ""}" data-speaking-mode="${id}"><span class="mode-index">0${index + 1}</span><small>${mode.eyebrow}</small><h3>${mode.title}</h3><p>${mode.description}</p><i>${speaking.mode === id ? "已选择" : "选择 →"}</i></button>`).join("")}
    </section>
    <section class="cabin-settings card">
      <div class="setting-group"><small>AI 的陪伴方式</small><div class="choice-row">${Object.entries(personaLabels).map(([id, label]) => `<button class="choice ${speaking.persona === id ? "selected" : ""}" data-speaking-persona="${id}">${label}</button>`).join("")}</div></div>
      <div class="setting-group"><small>说话节奏</small><div class="choice-row">${Object.entries(paceLabels).map(([id, label]) => `<button class="choice ${speaking.pace === id ? "selected" : ""}" data-speaking-pace="${id}">${label}${id === "slow" ? " · 推荐" : ""}</button>`).join("")}</div></div>
      <div class="setting-summary"><small>本次会带上的词</small><div>${words.map(word => `<span>${esc(word.term)}</span>`).join("")}</div><p>接入学习记录后，这里会自动读取你昨天掌握度最低的词。</p></div>
    </section>
    <div class="cabin-start"><div><strong>${speakingModes[speaking.mode].title}</strong><span>${personaLabels[speaking.persona]} · ${paceLabels[speaking.pace]}</span></div>${voiceReady ? `<button class="btn outline" data-action="start-speaking-demo">查看演示</button><button class="btn primary" data-action="start-speaking-live">开始真实通话</button>` : `<button class="btn primary" data-action="start-speaking-demo">先体验演示</button>`}</div>
  </section>`;
}

function formatCallTime(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function speakingCall() {
  const speaking = state.speaking;
  const mode = speakingModes[speaking.mode];
  const prompt = speaking.live && speaking.assistantText ? speaking.assistantText : mode.prompts[speaking.promptIndex % mode.prompts.length];
  const words = speakingWordList();
  const phaseLabels = {
    permission: "请允许使用麦克风",
    connecting: "正在连接词舟",
    session_starting: "正在准备英语老师",
    listening: speaking.pace === "slow" ? "我会等你说完" : "正在听你说",
    user_speaking: "听见你了，请继续",
    thinking: "正在理解你的表达",
    speaking: "词舟正在回答",
    error: "连接遇到问题",
    closed: "通话已经断开"
  };
  const presenceLabel = speaking.live ? (phaseLabels[speaking.phase] || "真实语音通话") : (speaking.micOn ? (speaking.pace === "slow" ? "我会等你说完" : "正在听你说") : "麦克风已暂停");
  return `<section class="page speaking-page call-page">
    <div class="call-stage">
      <div class="call-top"><button data-action="leave-speaking-demo">← ${speaking.live ? "结束并退出" : "退出演示"}</button><span><i></i> ${mode.title} · ${speaking.live ? "真实通话" : "演示通话"}</span><time id="call-time">${formatCallTime(speaking.seconds)}</time></div>
      <div class="call-presence">
        <div class="voice-orbit ${speaking.micOn && speaking.phase !== "error" ? "listening" : "paused"}"><div class="voice-core">舟</div><i></i><i></i><i></i></div>
        <small id="voice-phase">${presenceLabel}</small>
        <h1>词舟</h1><p>${personaLabels[speaking.persona]} · ${paceLabels[speaking.pace]}</p>
      </div>
      ${speaking.live && speaking.userText ? `<div class="live-user-caption"><small>YOU</small><span>${esc(speaking.userText)}</span></div>` : ""}
      <div class="call-prompt ${speaking.subtitlesOn ? "" : "subtitle-hidden"}"><small>WORDSAIL</small><p>${esc(prompt)}</p><span>${speaking.subtitlesOn ? "字幕已开启" : "字幕已隐藏，点击下方按钮重新显示"}</span></div>
      ${speaking.error ? `<div class="call-error"><strong>暂时没有接通</strong><span>${esc(speaking.error)}</span><button data-action="leave-speaking-demo">返回检查配置</button></div>` : ""}
      ${speaking.hintVisible ? `<div class="call-hint"><small>给你一个轻提示</small><p>可以从 <strong>“The atmosphere felt…”</strong> 开始，不需要一次说得完美。</p><div>${words.map(word => `<span>${esc(word.term)}</span>`).join("")}</div></div>` : ""}
      <div class="call-controls">
        <button class="call-control ${speaking.micOn ? "" : "off"}" data-action="toggle-demo-mic"><span>${speaking.micOn ? "◉" : "×"}</span><small>${speaking.micOn ? "麦克风" : "已静音"}</small></button>
        <button class="call-control" data-action="toggle-demo-subtitles"><span>文</span><small>${speaking.subtitlesOn ? "隐藏字幕" : "显示字幕"}</small></button>
        <button class="call-control warm" data-action="show-speaking-hint"><span>✦</span><small>给我提示</small></button>
        <button class="call-control" data-action="next-speaking-prompt"><span>→</span><small>${speaking.pace === "slow" ? "我说完了" : "换个问题"}</small></button>
        <button class="call-control end" data-action="finish-speaking-demo"><span>⌁</span><small>结束通话</small></button>
      </div>
      <div class="demo-notice">${speaking.live ? "麦克风音频通过本地代理发送至豆包实时语音；当前不保存原始录音。" : "当前为交互演示，不会录音，也不会生成真实评分。"}</div>
    </div>
  </section>`;
}

function speakingReport() {
  if (state.speaking.live) return speakingLiveReport();
  const mode = speakingModes[state.speaking.mode];
  const words = speakingWordList();
  return `<section class="page speaking-page report-page">
    ${pageHeading("AFTER THE CONVERSATION", "你没有逃开这次表达。", "这是一份示例报告，用来确认信息层级和视觉体验；接入真实语音后，所有内容都会来自用户本次通话。")}
    <section class="report-summary">
      <div><small>TODAY'S VOYAGE</small><h2>${mode.title}</h2><p>比起完美，更重要的是完成一次真实的开口。</p></div>
      <div class="report-time"><strong>${formatCallTime(Math.max(42, state.speaking.seconds))}</strong><span>演示通话</span></div>
    </section>
    <section class="report-metrics">
      <article><small>连续表达</small><strong>38 秒</strong><span>最长一次</span></article>
      <article><small>表达完成度</small><strong>清晰</strong><span>能够完成主要意思</span></article>
      <article><small>本次弱词</small><strong>${words.length}</strong><span>等待真实通话验证</span></article>
      <article><small>参考状态</small><strong>演示</strong><span>不是考试评分</span></article>
    </section>
    <div class="section-head"><h2>最值得带走的一处修改</h2><span class="section-note">一次只改一个重点</span></div>
    <section class="expression-review card"><div><small>你说</small><p>I very like the atmosphere there.</p></div><span>→</span><div><small>更准确、更自然</small><p>I really like the atmosphere there.</p></div></section>
    <div class="section-head"><h2>这些词正在变成你的表达</h2></div>
    <section class="report-words card">${words.map((word, index) => `<article><strong>${esc(word.term)}</strong><span>${index === 0 ? "已在表达中使用" : index === 1 ? "在提示后尝试" : "下次继续带上"}</span><i class="word-status status-${index}"></i></article>`).join("")}</section>
    <div class="report-actions"><button class="btn outline" data-action="reset-speaking-demo">返回口语舱</button><button class="btn primary" data-action="restart-speaking-demo">再说一次</button></div>
  </section>`;
}

function speakingLiveReport() {
  const speaking = state.speaking;
  const mode = speakingModes[speaking.mode];
  const words = speakingWordList();
  const userEntries = speaking.transcript.filter(entry => entry.role === "user");
  const uniqueUserLines = [...new Map(userEntries.map(entry => [entry.text, entry])).values()];
  const spokenText = uniqueUserLines.map(entry => entry.text).join(" ");
  const spokenWords = spokenText.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
  const usedWeakWords = words.filter(word => new RegExp(`\\b${String(word.term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(spokenText));
  return `<section class="page speaking-page report-page">
    ${pageHeading("AFTER THE CONVERSATION", "今晚，你真的开口了。", "本次先记录真实通话与转写结果。更细的语法、词汇和雅思维度评分会在下一阶段接入，当前不制造虚假的精确分数。")}
    <section class="report-summary"><div><small>TODAY'S VOYAGE</small><h2>${mode.title}</h2><p>从一次真实的开口开始，让词舟逐渐学会怎样陪你练习。</p></div><div class="report-time"><strong>${formatCallTime(speaking.seconds)}</strong><span>真实通话</span></div></section>
    <section class="report-metrics">
      <article><small>用户表达轮次</small><strong>${uniqueUserLines.length}</strong><span>根据实时语音转写</span></article>
      <article><small>转写英语词数</small><strong>${spokenWords.length}</strong><span>只用于本次体验参考</span></article>
      <article><small>主动使用弱词</small><strong>${usedWeakWords.length}</strong><span>共带入 ${words.length} 个词</span></article>
      <article><small>通话状态</small><strong>${speaking.error ? "中断" : "完成"}</strong><span>${speaking.error ? "可根据错误提示重试" : "语音链路已结束"}</span></article>
    </section>
    <div class="section-head"><h2>本次通话转写</h2><span class="section-note">测试阶段可能存在识别误差</span></div>
    <section class="live-transcript card">${speaking.transcript.length ? speaking.transcript.map(entry => `<article class="${entry.role}"><small>${entry.role === "user" ? "YOU" : "WORDSAIL"}</small><p>${esc(entry.text)}</p></article>`).join("") : `<div class="empty">本次没有收到完整转写。声音仍有播放时，可以等待一句结束后再挂断。</div>`}</section>
    <div class="section-head"><h2>弱词使用记录</h2></div>
    <section class="report-words card">${words.map(word => { const used = usedWeakWords.some(item => item.term === word.term); return `<article><strong>${esc(word.term)}</strong><span>${used ? "已经在真实表达中使用" : "下一次继续带上"}</span><i class="word-status ${used ? "status-0" : "status-2"}"></i></article>`; }).join("")}</section>
    <div class="report-actions"><button class="btn outline" data-action="reset-speaking-demo">返回口语舱</button><button class="btn primary" data-action="start-speaking-live">再说一次</button></div>
  </section>`;
}

function speakingPage() {
  if (state.speaking.screen === "call") return speakingCall();
  if (state.speaking.screen === "report") return speakingReport();
  return speakingLobby();
}

function chapterOptions() {
  return state.catalog.chapters.map(chapter => `<option value="${esc(chapter.id)}" ${chapter.id === state.activeChapterId ? "selected" : ""}>${String(chapter.number || "").padStart(2, "0")} · ${esc(chapter.title)}（${chapter.totalWords || chapter.words.length}）</option>`).join("");
}

function wordRow(word) {
  const progress = state.progress[word.id];
  return `<article class="word-row">
    <div class="word-term"><strong>${esc(word.term)}</strong><small>${esc(word.phonetic || "音标待补充")}</small></div>
    <div class="word-meaning">${esc(word.meaning || "释义待补充")}${word.collocations?.[0] ? `<small> · ${esc(word.collocations[0])}</small>` : ""}</div>
    <span class="tag ${esc(word.sourceType)}">${progress?.mastery ? `${progress.mastery}% 掌握` : esc(word.topicTags?.[0] || "未学习")}</span>
    <button class="word-open" data-study-word="${esc(word.id)}" aria-label="学习 ${esc(word.term)}">→</button>
  </article>`;
}

function libraryPage() {
  const chapter = activeChapter();
  const query = state.query.trim().toLowerCase();
  const words = (chapter?.words || []).filter(word => `${word.term} ${word.meaning}`.toLowerCase().includes(query)).slice(0, 160);
  const description = state.catalog.publicationReady
    ? "首轮内测开放 30 个原创核心词条。先验证检索、学习和复习是否真正有用，再根据用户反馈持续扩充。"
    : "当前使用本机私人参考数据验证检索、学习和复习体验；该数据不会进入公开版本。";
  return `<section class="page">
    ${pageHeading("VOCABULARY ATLAS", "让词汇成为一张可以探索的地图。", description)}
    <div class="toolbar"><label for="chapter">选择词集</label><select id="chapter">${chapterOptions()}</select><div class="search"><input id="word-search" value="${esc(state.query)}" placeholder="搜索单词或中文释义" autocomplete="off"><span>⌕</span></div></div>
    <section class="library-intro card"><div><h3>${esc(chapter?.title || "词集")}</h3><p>${chapter?.totalWords || chapter?.words.length || 0} 个词条 · ${esc(chapter?.description || "")}</p></div><button class="btn primary" data-action="start-chapter">从这里开始</button></section>
    <section class="word-list card"><div class="word-list-head"><span>单词</span><span>释义与搭配</span><span>状态</span><span></span></div>${words.length ? words.map(wordRow).join("") : `<div class="empty">没有找到匹配的单词。</div>`}</section>
  </section>`;
}

function startSession(words) {
  state.session = words.filter(Boolean);
  state.sessionIndex = 0;
  state.revealed = false;
  go("study");
}

function studyPage() {
  const word = currentWord();
  if (!word) {
    return `<section class="page">${pageHeading("FOCUSED PRACTICE", "准备好时，再开始一组。", "每组十个词。先主动回忆，再查看答案，最后根据真实感受安排下一次复习。")}
      <section class="hero"><div class="hero-copy"><small>READY WHEN YOU ARE</small><h2>从当前词集选十个词，完成一次安静而完整的学习。</h2><p>不追求一次记住。目标是让每次遗忘都有下一次准确出现的机会。</p><div class="hero-actions"><button class="btn primary" data-action="quick-start">开始学习</button><button class="btn ghost" data-action="review-due">复习到期词</button></div></div></section></section>`;
  }
  const percent = Math.round(((state.sessionIndex + (state.revealed ? .5 : 0)) / state.session.length) * 100);
  return `<section class="page">
    ${pageHeading("FOCUSED PRACTICE", `第 ${state.sessionIndex + 1} 个词，先别急着看答案。`, "在脑中说出一个含义或使用场景，再点击查看。主动回忆比重复浏览更有价值。")}
    <div class="study-layout">
      <section class="study-card card">
        <div class="study-progress"><span>本组进度 · ${state.sessionIndex + 1}/${state.session.length}</span><span>${percent}%</span></div><div class="study-progress-line"><i style="width:${percent}%"></i></div>
        <div class="study-term">${esc(word.term)}</div><div class="phonetic">${esc(word.phonetic || "音标待补充")}<button class="speak" data-speak="${esc(word.term)}">◖))</button></div>
        <div class="prompt">${state.revealed ? "MEANING & USE" : "ACTIVE RECALL"}</div>
        ${state.revealed ? `<div class="reveal-panel"><h3>${esc(word.meaning || "释义待补充")}</h3><p>${word.collocations?.length ? `常见搭配：${word.collocations.slice(0,3).map(esc).join(" · ")}` : "搭配内容待补充"}</p>${word.example ? `<p class="example">${esc(word.example)}</p><p class="example-zh">${esc(word.exampleZh)}</p>` : ""}</div><div class="study-actions"><button class="grade-btn again" data-grade="again">没想起来 · 现在再来</button><button class="grade-btn" data-grade="hard">有点模糊 · 明天</button><button class="grade-btn good" data-grade="good">想起来了 · 拉开间隔</button></div>` : `<div class="reveal-panel"><h3>你能用自己的话解释它吗？</h3><p>不必完全复述释义。先想一个含义、搭配或能放进句子里的场景。</p></div><div class="study-actions"><button class="btn primary" data-action="reveal">查看含义与用法</button><button class="btn outline" data-action="skip">暂时跳过</button></div>`}
      </section>
      <aside class="study-side">
        <section class="side-card card"><h3>词形与表达</h3><div class="chip-wrap">${(word.forms?.length ? word.forms : ["待补充词形"]).slice(0,6).map(item => `<span class="chip">${esc(item)}</span>`).join("")}</div></section>
        <section class="side-card card"><h3>话题连接</h3><div class="chip-wrap">${(word.topicTags?.length ? word.topicTags : ["待标注话题"]).map(item => `<span class="chip">${esc(item)}</span>`).join("")}</div></section>
        ${word.sourceType === "private-reference" ? `<section class="side-card card source-warning"><h3>本机参考内容</h3><p>此词条只用于开发验证，不属于发布数据。正式上线前必须切换为原创、授权或开放许可内容。</p></section>` : ""}
      </aside>
    </div>
  </section>`;
}

function progressPage() {
  const words = allWords();
  const stats = catalogStats(state.catalog.chapters, state.progress);
  const studied = words.filter(word => state.progress[word.id]?.attempts).sort((a, b) => new Date(state.progress[b.id].lastStudied) - new Date(state.progress[a.id].lastStudied)).slice(0, 30);
  return `<section class="page">
    ${pageHeading("LEARNING SIGNALS", "看见进步，但不被数字牵着走。", "报告只回答三个问题：学过什么、什么时候该回来，以及哪些词已经能够稳定想起。")}
    <section class="progress-hero"><div><h2>${stats.studied ? "你已经开始建立自己的词汇路径。" : "完成第一组学习，进度会从这里生长。"}</h2><p>掌握度来自你的真实反馈，不代表考试分数。它只用于决定下一次复习时间。</p></div><div class="big-progress"><span class="big-number">${stats.average}%</span><span class="progress-note">平均掌握度<br>${stats.studied}/${stats.total} 已学习</span></div></section>
    <div class="section-head"><h2>最近学习</h2><button data-action="review-due">复习到期词 →</button></div>
    <section class="history-list card">${studied.length ? studied.map(word => { const progress = state.progress[word.id]; return `<article class="history-item"><div><strong>${esc(word.term)}</strong><small>${esc(word.meaning)}</small></div><span class="history-score">${progress.mastery}% 掌握</span><time>${new Date(progress.lastStudied).toLocaleDateString("zh-CN")}</time></article>`; }).join("") : `<div class="empty">还没有学习记录。完成第一组十个词吧。</div>`}</section>
  </section>`;
}

function render() {
  if (!["home", "library", "study", "speaking", "progress"].includes(state.page)) state.page = "home";
  const pages = { home: homePage, library: libraryPage, study: studyPage, speaking: speakingPage, progress: progressPage };
  app.innerHTML = shell(pages[state.page]());
  scheduleMottoRotation();
}

function startSpeakingTimer() {
  clearInterval(state.speaking.timer);
  state.speaking.timer = setInterval(() => {
    state.speaking.seconds += 1;
    const element = document.getElementById("call-time");
    if (element) element.textContent = formatCallTime(state.speaking.seconds);
  }, 1000);
}

function stopSpeakingTimer() {
  clearInterval(state.speaking.timer);
  state.speaking.timer = null;
}

function resetSpeakingRuntime(live) {
  state.speaking.live = live;
  state.speaking.screen = "call";
  state.speaking.seconds = 0;
  state.speaking.promptIndex = 0;
  state.speaking.hintVisible = false;
  state.speaking.micOn = true;
  state.speaking.phase = live ? "permission" : "listening";
  state.speaking.error = "";
  state.speaking.userText = "";
  state.speaking.assistantText = "";
  state.speaking.transcript = [];
}

function recordLiveTranscript(role, text) {
  const normalized = String(text || "").trim();
  if (!normalized) return;
  const transcript = state.speaking.transcript;
  const last = transcript[transcript.length - 1];
  if (last?.role === role) last.text = normalized;
  else transcript.push({ role, text: normalized });
  if (role === "user") state.speaking.userText = normalized;
  else state.speaking.assistantText = normalized;
  render();
}

async function beginLiveSpeaking() {
  if (!state.voiceStatus.configured) return toast("请先完成豆包实时语音配置");
  trackEvent("speaking_live_started", { mode: state.speaking.mode, persona: state.speaking.persona, pace: state.speaking.pace });
  await voiceClient?.stop?.();
  resetSpeakingRuntime(true);
  render();
  startSpeakingTimer();
  voiceClient = new VoiceAIClient({
    onState: phase => {
      state.speaking.phase = phase;
      if (phase === "closed" && state.speaking.screen === "call" && !state.speaking.error) state.speaking.error = "语音连接已经断开，可以返回后重新拨打。";
      render();
    },
    onReady: () => {
      state.speaking.phase = "listening";
      render();
    },
    onTranscript: recordLiveTranscript,
    onError: error => {
      state.speaking.phase = "error";
      state.speaking.error = error.message;
      render();
    }
  });
  try {
    await voiceClient.start({
      mode: state.speaking.mode,
      persona: state.speaking.persona,
      pace: state.speaking.pace,
      weakWords: speakingWordList().map(word => word.term)
    });
  } catch (error) {
    state.speaking.phase = "error";
    state.speaking.error = error.name === "NotAllowedError" ? "麦克风权限被拒绝。请在浏览器地址栏左侧允许麦克风后再试。" : error.message;
    render();
  }
}

async function leaveSpeaking(showReport = false) {
  stopSpeakingTimer();
  if (state.speaking.live) {
    const client = voiceClient;
    voiceClient = null;
    await client?.stop?.();
  }
  state.speaking.screen = showReport ? "report" : "lobby";
  render();
}

function rotateMotto(direction = 1) {
  state.mottoIndex = (state.mottoIndex + direction + universityMottos.length) % universityMottos.length;
  const heading = document.querySelector(".motto-heading");
  if (heading) heading.outerHTML = mottoHeading();
  scheduleMottoRotation();
}

function scheduleMottoRotation() {
  clearInterval(state.mottoTimer);
  if (state.page !== "home" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  state.mottoTimer = setInterval(() => rotateMotto(1), 9000);
}

function go(page) {
  state.page = page;
  if (location.hash !== `#${page}`) history.pushState(null, "", `#${page}`);
  trackEvent("page_view", { destination: page });
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toast(message) {
  const element = document.getElementById("toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
}

function quickStart() {
  const chapter = activeChapter();
  const notStudied = (chapter.words || []).filter(word => !state.progress[word.id]?.attempts);
  const pool = notStudied.length ? notStudied : chapter.words || [];
  trackEvent("learning_started", { chapter: chapter?.id || "unknown", words: Math.min(10, pool.length) });
  startSession(pool.slice(0, 10));
}

function reviewDue() {
  const dueIds = new Set(dueWordIds(state.progress));
  const words = allWords().filter(word => dueIds.has(word.id));
  if (!words.length) return toast("今天暂时没有到期词，先学一组新词吧");
  startSession(words.slice(0, 20));
}

function finishGrade(grade) {
  const word = currentWord();
  if (!word) return;
  state.progress[word.id] = updateProgress(state.progress[word.id], grade);
  trackEvent("word_graded", { grade, wordId: word.id });
  if (!state.activityDates.includes(todayKey())) state.activityDates.push(todayKey());
  saveLocalState();
  if (state.sessionIndex >= state.session.length - 1) {
    state.session = [];
    state.sessionIndex = 0;
    state.revealed = false;
    go("progress");
    requestAnimationFrame(() => toast("这一组完成了，下一次复习已经安排好"));
    return;
  }
  state.sessionIndex += 1;
  state.revealed = false;
  render();
}

function speak(text) {
  if (!("speechSynthesis" in window)) return toast("当前浏览器不支持语音播放");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = .82;
  speechSynthesis.speak(utterance);
}

document.addEventListener("click", event => {
  const ratingButton = event.target.closest("[data-feedback-rating]");
  if (ratingButton) {
    state.feedbackRating = Number(ratingButton.dataset.feedbackRating);
    document.querySelectorAll("[data-feedback-rating]").forEach(button => button.classList.toggle("active", button === ratingButton));
    return;
  }
  const modeButton = event.target.closest("[data-speaking-mode]");
  if (modeButton) { state.speaking.mode = modeButton.dataset.speakingMode; return render(); }
  const personaButton = event.target.closest("[data-speaking-persona]");
  if (personaButton) { state.speaking.persona = personaButton.dataset.speakingPersona; return render(); }
  const paceButton = event.target.closest("[data-speaking-pace]");
  if (paceButton) { state.speaking.pace = paceButton.dataset.speakingPace; return render(); }
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) return go(pageButton.dataset.page);
  const speakButton = event.target.closest("[data-speak]");
  if (speakButton) return speak(speakButton.dataset.speak);
  const wordButton = event.target.closest("[data-study-word]");
  if (wordButton) {
    const word = allWords().find(item => item.id === wordButton.dataset.studyWord);
    return startSession([word]);
  }
  const gradeButton = event.target.closest("[data-grade]");
  if (gradeButton) return finishGrade(gradeButton.dataset.grade);
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === "open-feedback") { state.overlay = "feedback"; state.feedbackRating = 0; return render(); }
  if (action === "open-account") { state.overlay = "account"; return render(); }
  if (action === "open-policy") { state.overlay = "policy"; return render(); }
  if (action === "close-overlay") { state.overlay = null; return render(); }
  if (action === "dismiss-welcome") {
    localStorage.setItem(WELCOME_KEY, "seen");
    state.overlay = null;
    trackEvent("welcome_dismissed");
    return render();
  }
  if (action === "start-first-voyage") {
    localStorage.setItem(WELCOME_KEY, "seen");
    state.overlay = null;
    trackEvent("welcome_started");
    return quickStart();
  }
  if (action === "quick-start") quickStart();
  if (action === "review-due") reviewDue();
  if (action === "start-chapter") quickStart();
  if (action === "reveal") { state.revealed = true; render(); }
  if (action === "motto-prev") rotateMotto(-1);
  if (action === "motto-next") rotateMotto(1);
  if (action === "start-speaking-demo" || action === "restart-speaking-demo") {
    trackEvent("speaking_demo_started", { mode: state.speaking.mode, persona: state.speaking.persona, pace: state.speaking.pace });
    resetSpeakingRuntime(false);
    render();
    startSpeakingTimer();
  }
  if (action === "start-speaking-live") beginLiveSpeaking();
  if (action === "finish-speaking-demo") leaveSpeaking(true);
  if (action === "leave-speaking-demo" || action === "reset-speaking-demo") leaveSpeaking(false);
  if (action === "toggle-demo-mic") {
    state.speaking.micOn = !state.speaking.micOn;
    if (state.speaking.live) voiceClient?.setMuted(!state.speaking.micOn);
    render();
  }
  if (action === "toggle-demo-subtitles") { state.speaking.subtitlesOn = !state.speaking.subtitlesOn; render(); }
  if (action === "show-speaking-hint") {
    state.speaking.hintVisible = !state.speaking.hintVisible;
    if (state.speaking.live && state.speaking.hintVisible) voiceClient?.sendPrompt("You can begin with: The atmosphere felt memorable because... Take your time.");
    render();
  }
  if (action === "next-speaking-prompt") {
    state.speaking.promptIndex = (state.speaking.promptIndex + 1) % speakingModes[state.speaking.mode].prompts.length;
    state.speaking.hintVisible = false;
    if (state.speaking.live) voiceClient?.sendPrompt(speakingModes[state.speaking.mode].prompts[state.speaking.promptIndex]);
    render();
  }
  if (action === "skip") {
    if (state.sessionIndex < state.session.length - 1) { state.sessionIndex += 1; state.revealed = false; render(); }
    else { state.session = []; go("home"); }
  }
});

document.addEventListener("submit", async event => {
  if (event.target.id !== "feedback-form") return;
  event.preventDefault();
  if (!state.feedbackRating) return toast("请先选择 1—5 分体验评分");
  const form = new FormData(event.target);
  state.feedbackSending = true;
  render();
  try {
    const payload = {
      rating: state.feedbackRating,
      message: form.get("message"),
      contact: form.get("contact"),
      sessionId: sessionId(),
      page: state.page,
      createdAt: new Date().toISOString()
    };
    if (cloudSync?.enabled) {
      await cloudSync.recordFeedback(payload);
    } else {
      const response = await fetch(apiEndpoint("/api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
    trackEvent("feedback_submitted", { rating: state.feedbackRating });
    state.feedbackSending = false;
    state.feedbackRating = 0;
    state.overlay = null;
    render();
    requestAnimationFrame(() => toast("收到啦，谢谢你帮词舟校准方向"));
  } catch {
    state.feedbackSending = false;
    render();
    requestAnimationFrame(() => toast("反馈暂时没有送达，请稍后再试"));
  }
});

document.addEventListener("change", event => {
  if (event.target.id !== "chapter") return;
  state.activeChapterId = event.target.value;
  state.query = "";
  saveLocalState();
  render();
});

document.addEventListener("input", event => {
  if (event.target.id !== "word-search") return;
  state.query = event.target.value;
  render();
  requestAnimationFrame(() => {
    const input = document.getElementById("word-search");
    input?.focus();
    input?.setSelectionRange(state.query.length, state.query.length);
  });
});

window.addEventListener("popstate", () => { leaveSpeaking(false); state.page = location.hash.slice(1) || "home"; render(); });

async function init() {
  loadLocalState();
  cloudSync = createCloudSync(globalThis.WORDSAIL_CONFIG?.cloudBase, {
    onStatus(cloudState) {
      state.cloud = cloudState;
      if (state.catalog) render();
    },
    onRemoteState: applyCloudSnapshot
  });
  cloudSync.init(learningSnapshot());
  try {
    let response;
    try { response = await fetch(apiEndpoint("/api/catalog?limit=500")); } catch { /* Static deployment fallback below. */ }
    if (!response?.ok) response = await fetch("./catalog.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.catalog = await response.json();
    try {
      const voiceResponse = await fetch(apiEndpoint("/api/voice/status"));
      state.voiceStatus = voiceResponse.ok ? { ...(await voiceResponse.json()), loading: false } : { configured: false, loading: false, authMode: "missing" };
    } catch {
      state.voiceStatus = { configured: false, loading: false, authMode: "missing" };
    }
    if (!state.activeChapterId || !state.catalog.chapters.some(chapter => chapter.id === state.activeChapterId && chapter.words.length)) {
      state.activeChapterId = state.catalog.chapters.find(chapter => chapter.words.length)?.id || state.catalog.chapters[0]?.id || "";
    }
    if (!localStorage.getItem(WELCOME_KEY)) state.overlay = "welcome";
    render();
    trackEvent("page_view", { destination: state.page, firstVisit: state.overlay === "welcome" });
  } catch (error) {
    app.innerHTML = `<div class="loading-screen"><div class="loading-mark">!</div><p>词舟暂时没有顺利靠岸：${esc(error.message)}</p><p>请稍后刷新页面；如果问题持续出现，可以通过发布者提供的联系方式反馈。</p></div>`;
  }
}

init();
