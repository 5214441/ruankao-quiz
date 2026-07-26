(() => {
"use strict";

const DATA_URL = "data/projects.json";
const META_URL = "data/meta.json";
const CONFIG_URL = "config.json";
const MONITOR_URL = "data/monitor_status.json";
const USER_STORE = "tenderBoardUserDataV13";
const OLD_USER_STORE = "luanTenderBoardUserDataV1";
const COMPANY_STORE = "tenderCompanyProfileV13";
const NOTICE_STORE = "tenderNoticeHistoryV13";

const STATUS_ACTIVE = new Set([
  "重点关注","准备报名","已报名","商务标制作","技术标制作","保证金已缴","已上传"
]);
const CATEGORY_REQUIREMENTS = {
  "房建":["建筑工程","房屋建筑","建造师"],
  "市政":["市政公用","市政工程","建造师"],
  "公路":["公路工程","道路","桥梁","建造师"],
  "水利":["水利水电","水利工程","建造师"]
};
const TASK_LABELS = {
  download:"下载招标文件",
  qualification:"核对资质和人员",
  guarantee:"安排保证金",
  business:"完成商务标",
  technical:"完成技术标",
  upload:"签章并上传"
};

const $ = id => document.getElementById(id);
const esc = (text="") => String(text).replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
}[c]));
const fmtDate = value => value ? new Intl.DateTimeFormat("zh-CN",{
  year:"numeric",month:"2-digit",day:"2-digit"
}).format(new Date(value)) : "未识别";
const fmtDateTime = value => value ? new Intl.DateTimeFormat("zh-CN",{
  month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false
}).format(new Date(value)) : "未识别";

function loadJSON(key, fallback){
  try{
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  }catch{
    return fallback;
  }
}
function saveJSON(key, value){ localStorage.setItem(key, JSON.stringify(value)); }
function migrateUserData(){
  const current = loadJSON(USER_STORE, null);
  if(current) return current;
  const old = loadJSON(OLD_USER_STORE, {});
  const migrated = {};
  Object.entries(old).forEach(([id, item]) => {
    migrated[id] = {
      favorite:!!item.favorite,
      status:item.status === "未跟进" ? "待分析" : (item.status || "待分析"),
      note:item.note || "",
      owner:"",
      nextAction:"",
      customDeadline:"",
      guaranteeWan:"",
      advanceWan:"",
      checklist:{}
    };
  });
  saveJSON(USER_STORE, migrated);
  return migrated;
}
function defaultProjectData(){
  return {
    favorite:false,status:"待分析",note:"",owner:"",nextAction:"",
    customDeadline:"",guaranteeWan:"",advanceWan:"",checklist:{}
  };
}
function defaultCompany(){
  return {
    name:"",qualifications:"",personnel:"",performance:"",
    maxGuaranteeWan:"",maxAdvanceWan:"",
    preferredCategories:[],reminderDays:[7,3,1]
  };
}

const state = {
  projects:[], meta:{}, config:{}, monitor:{}, filtered:[],
  activeProject:null,
  userData:migrateUserData(),
  company:Object.assign(defaultCompany(),loadJSON(COMPANY_STORE,{})),
  notices:loadJSON(NOTICE_STORE,{}),
  filters:{
    search:"",days:"7",sort:"dateDesc",status:"all",
    regions:new Set(),categories:new Set(["房建","市政","公路","水利"]),
    constructionOnly:true,favoriteOnly:false,trackingOnly:false
  }
};

function toast(message){
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 2300);
}
function getLocal(project){
  return Object.assign(defaultProjectData(), state.userData[project.id] || {});
}
function setLocal(project, patch){
  state.userData[project.id] = Object.assign(getLocal(project), patch);
  saveJSON(USER_STORE, state.userData);
}
function normalizeText(value){ return String(value || "").toLowerCase().replace(/\s+/g,""); }
function tokens(value){
  return String(value || "").split(/[，,、；;\s/]+/).map(x=>x.trim()).filter(Boolean);
}
function projectText(project){
  return [
    project.title,project.region,project.category,project.summary,
    project.qualification,project.tenderer,project.type
  ].join(" ");
}
function deadlineValue(project){
  const local = getLocal(project);
  return local.customDeadline || project.deadline || "";
}
function daysTo(value){
  if(!value) return null;
  const t = new Date(value).getTime();
  if(Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}
function toInputDateTime(value){
  if(!value) return "";
  const d = new Date(value);
  if(Number.isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function budgetText(value){
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? `${n.toLocaleString("zh-CN",{maximumFractionDigits:4})} 万元`
    : "未识别";
}
function moneyLimit(value){
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${n.toLocaleString("zh-CN")}万元` : "未设置";
}
function isTracking(local){
  return local.favorite || STATUS_ACTIVE.has(local.status);
}
function completedTaskCount(local){
  return Object.values(local.checklist || {}).filter(Boolean).length;
}

function companyMatch(project){
  const company = state.company;
  const local = getLocal(project);
  const companyText = normalizeText([
    company.qualifications,company.personnel,company.performance
  ].join(" "));
  const pText = normalizeText(projectText(project));
  let score = 35;
  const strengths = [];
  const risks = [];

  if(company.preferredCategories?.length){
    if(company.preferredCategories.includes(project.category)){
      score += 18;
      strengths.push(`属于重点行业：${project.category}`);
    }else{
      score -= 8;
      risks.push(`不在已设置的重点行业`);
    }
  }else{
    risks.push("尚未设置重点行业");
  }

  const required = CATEGORY_REQUIREMENTS[project.category] || [];
  const hits = required.filter(word => companyText.includes(normalizeText(word)));
  if(hits.length){
    score += Math.min(24, hits.length * 9);
    strengths.push(`资质/人员关键词命中：${hits.join("、")}`);
  }else if(required.length){
    score -= 12;
    risks.push(`未在公司档案中识别到${project.category}相关资质`);
  }

  const perf = tokens(company.performance);
  const perfHits = perf.filter(word => word.length >= 2 && pText.includes(normalizeText(word)));
  if(perfHits.length){
    score += Math.min(18, perfHits.length * 6);
    strengths.push(`类似业绩关键词：${perfHits.slice(0,4).join("、")}`);
  }else if(perf.length){
    risks.push("未识别到明显的类似业绩关键词");
  }else{
    risks.push("尚未填写类似业绩");
  }

  if(project.isEpc){
    if(/设计|epc|联合体/i.test(company.qualifications + company.performance)){
      score += 8;
      strengths.push("档案中存在EPC/设计/联合体能力");
    }else{
      score -= 10;
      risks.push("EPC项目需重点核查设计资质或联合体");
    }
  }

  const guarantee = Number(local.guaranteeWan);
  const maxGuarantee = Number(company.maxGuaranteeWan);
  if(guarantee > 0 && maxGuarantee > 0){
    if(guarantee <= maxGuarantee){
      score += 5;
      strengths.push("预计保证金在承受范围内");
    }else{
      score -= 18;
      risks.push(`预计保证金超过档案上限${moneyLimit(maxGuarantee)}`);
    }
  }
  const advance = Number(local.advanceWan);
  const maxAdvance = Number(company.maxAdvanceWan);
  if(advance > 0 && maxAdvance > 0){
    if(advance <= maxAdvance){
      score += 5;
      strengths.push("预计垫资在承受范围内");
    }else{
      score -= 18;
      risks.push(`预计垫资超过档案上限${moneyLimit(maxAdvance)}`);
    }
  }

  if(!company.name && !company.qualifications && !company.personnel){
    score = 0;
    risks.splice(0, risks.length, "请先填写公司资质档案");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 75 ? "高匹配" : score >= 55 ? "需核查" : score > 0 ? "匹配较低" : "未配置";
  const tone = score >= 75 ? "high" : score >= 55 ? "medium" : "low";
  return {score,label,tone,strengths,risks};
}

async function loadData(){
  $("updateStatus").textContent = "正在读取最新数据…";
  const bust = `?v=${Date.now()}`;
  const [projectsRes,metaRes,configRes,monitorRes] = await Promise.all([
    fetch(DATA_URL+bust),fetch(META_URL+bust),fetch(CONFIG_URL+bust),fetch(MONITOR_URL+bust)
  ]);
  if(!projectsRes.ok) throw new Error("项目数据读取失败");
  state.projects = await projectsRes.json();
  state.meta = metaRes.ok ? await metaRes.json() : {};
  state.config = configRes.ok ? await configRes.json() : {};
  state.monitor = monitorRes.ok ? await monitorRes.json() : {};

  const defaults = state.config.defaultRegions || state.config.regions || [];
  state.filters.regions = new Set(defaults);
  state.filters.categories = new Set(state.config.categories || ["房建","市政","公路","水利"]);
  renderFilterChips();
  applyFilters();

  const updated = state.meta.updatedAt ? fmtDateTime(state.meta.updatedAt) : "暂无";
  if(state.meta.success === false){
    const attempted = state.meta.lastAttemptAt ? fmtDateTime(state.meta.lastAttemptAt) : "未知";
    $("updateStatus").textContent = `抓取失败（${attempted}），显示上一次成功数据 · ${state.projects.length}个项目`;
  }else{
    $("updateStatus").textContent = `数据更新时间：${updated} · 共收录${state.projects.length}个项目`;
  }
  $("sourceStatus").textContent = `来源：${state.meta.sourceName || "公共资源交易中心"} · 每天09:17和11:17检查`;
  checkBrowserNotices();
}

function renderFilterChips(){
  const regions = state.config.regions || [...new Set(state.projects.map(p=>p.region).filter(Boolean))];
  const categories = state.config.categories || ["房建","市政","公路","水利"];
  $("regionChips").innerHTML = regions.map(region =>
    `<button class="chip ${state.filters.regions.has(region)?"active":""}" data-region="${esc(region)}">${esc(region)}</button>`
  ).join("");
  $("categoryChips").innerHTML = categories.map(category =>
    `<button class="chip ${state.filters.categories.has(category)?"active":""}" data-category="${esc(category)}">${esc(category)}</button>`
  ).join("");

  document.querySelectorAll("[data-region]").forEach(btn => btn.addEventListener("click",()=>{
    const value = btn.dataset.region;
    state.filters.regions.has(value) ? state.filters.regions.delete(value) : state.filters.regions.add(value);
    btn.classList.toggle("active");
    applyFilters();
  }));
  document.querySelectorAll("[data-category]").forEach(btn => btn.addEventListener("click",()=>{
    const value = btn.dataset.category;
    state.filters.categories.has(value) ? state.filters.categories.delete(value) : state.filters.categories.add(value);
    btn.classList.toggle("active");
    applyFilters();
  }));
}
function isPureService(project){
  const text = `${project.title} ${project.type || ""}`;
  return /勘察|设计|监理|咨询|检测|审计|造价|全过程工程咨询/.test(text) && !/EPC|总承包|施工/.test(text);
}
function withinDays(value, days){
  if(days === "all") return true;
  const t = new Date(value).getTime();
  if(Number.isNaN(t)) return true;
  const diff = (Date.now() - t) / 86400000;
  return diff >= -1 && diff <= Number(days);
}
function applyFilters(){
  const f = state.filters;
  const keyword = normalizeText(f.search);
  let result = state.projects.filter(project => {
    const local = getLocal(project);
    const haystack = normalizeText(projectText(project) + " " + local.note + " " + local.owner + " " + local.nextAction);
    if(keyword && !haystack.includes(keyword)) return false;
    if(f.regions.size && !f.regions.has(project.region)) return false;
    if(f.categories.size && !f.categories.has(project.category)) return false;
    if(!withinDays(project.publishDate,f.days)) return false;
    if(f.constructionOnly && isPureService(project)) return false;
    if(f.favoriteOnly && !local.favorite) return false;
    if(f.trackingOnly && !isTracking(local)) return false;
    if(f.status !== "all" && local.status !== f.status) return false;
    return true;
  });

  result.sort((a,b)=>{
    if(f.sort === "companyMatchDesc") return companyMatch(b).score - companyMatch(a).score;
    if(f.sort === "scoreDesc") return (b.score||0)-(a.score||0);
    if(f.sort === "deadlineAsc"){
      const ad = deadlineValue(a) ? new Date(deadlineValue(a)).getTime() : Infinity;
      const bd = deadlineValue(b) ? new Date(deadlineValue(b)).getTime() : Infinity;
      return ad-bd;
    }
    if(f.sort === "budgetDesc") return (b.budgetWan||0)-(a.budgetWan||0);
    return new Date(b.publishDate)-new Date(a.publishDate);
  });
  state.filtered = result;
  renderAll();
}
function deadlineText(project){
  const value = deadlineValue(project);
  const days = daysTo(value);
  if(days === null) return "截止时间未识别";
  if(days < 0) return `已逾期${Math.abs(days)}天`;
  if(days === 0) return "今天截止";
  return `${days}天后截止`;
}
function deadlineTone(project){
  const days = daysTo(deadlineValue(project));
  if(days === null) return "amber";
  if(days < 0 || days <= 1) return "red";
  if(days <= 7) return "amber";
  return "blue";
}
function renderAll(){
  renderMetrics();
  renderProjects();
  renderFocus();
  renderMonitor();
  renderCompany();
  renderReminders();
}
function trackedProjects(){
  return state.projects.filter(project => isTracking(getLocal(project)));
}
function reminderItems(){
  const items = [];
  trackedProjects().forEach(project => {
    const local = getLocal(project);
    const value = deadlineValue(project);
    const days = daysTo(value);
    if(value && days !== null && days <= 7){
      items.push({
        project,type:"deadline",days,time:new Date(value).getTime(),
        text:days < 0 ? `已逾期${Math.abs(days)}天` : days === 0 ? "今天截止" : `${days}天后截止`
      });
    }
    if(local.nextAction){
      items.push({
        project,type:"action",days:null,time:value ? new Date(value).getTime() : Infinity,
        text:local.nextAction
      });
    }
  });
  return items.sort((a,b)=>a.time-b.time);
}
function renderMetrics(){
  const today = new Date().toISOString().slice(0,10);
  const todayCount = state.filtered.filter(p=>String(p.publishDate).slice(0,10)===today).length;
  const deadlineCount = state.filtered.filter(p=>{
    const d=daysTo(deadlineValue(p));
    return d!==null && d>=0 && d<=7;
  }).length;
  const high = state.filtered.filter(p=>companyMatch(p).score>=75).length;
  $("metricTotal").textContent = state.filtered.length;
  $("metricToday").textContent = todayCount;
  $("metricDeadline").textContent = deadlineCount;
  $("metricHigh").textContent = high;
  $("metricTracking").textContent = trackedProjects().length;
  $("metricReminders").textContent = reminderItems().filter(x=>x.type==="deadline").length;
  $("resultText").textContent = `当前显示${state.filtered.length}个项目，原始数据${state.projects.length}个`;
}
function renderProjects(){
  const container = $("projectList");
  $("emptyState").classList.toggle("hidden",state.filtered.length!==0);
  container.innerHTML = state.filtered.map(project=>{
    const local = getLocal(project);
    const match = companyMatch(project);
    const taskCount = completedTaskCount(local);
    const due = deadlineValue(project);
    return `<article class="project-card match-${match.tone}">
      <div class="project-top">
        <div>
          <div class="badges">
            <span class="badge blue">${esc(project.region||"未知地区")}</span>
            <span class="badge">${esc(project.category||"其他")}</span>
            ${project.isSecond?'<span class="badge amber">二次招标</span>':""}
            ${project.isEpc?'<span class="badge green">EPC</span>':""}
            ${due?`<span class="badge ${deadlineTone(project)}">${esc(deadlineText(project))}</span>`:""}
          </div>
          <h3 class="project-title">${esc(project.title)}</h3>
        </div>
        <div class="score-box ${match.tone}">
          <strong>${match.score || "—"}</strong>
          <span>${esc(match.label)}</span>
        </div>
      </div>
      <div class="project-meta">
        <span>发布日期：<b>${fmtDate(project.publishDate)}</b></span>
        <span>预算/控制价：<b>${budgetText(project.budgetWan)}</b></span>
        <span>截止时间：<b>${due?fmtDateTime(due):"未识别"}</b></span>
      </div>
      <p class="summary">${esc(project.summary||"请进入原公告核对完整范围、资质、评标办法和投标截止时间。")}</p>
      <div class="project-progress">
        <span class="status-pill">${esc(local.status)}</span>
        ${local.owner?`<span>负责人：<b>${esc(local.owner)}</b></span>`:""}
        ${local.nextAction?`<span>下一步：<b>${esc(local.nextAction)}</b></span>`:""}
        ${taskCount?`<span>清单：<b>${taskCount}/6</b></span>`:""}
      </div>
      <div class="project-footer">
        <div class="local-state">
          ${local.favorite?'<span class="badge amber">已收藏</span>':""}
          ${local.note?'<span class="badge green">已备注</span>':""}
          ${match.risks[0]?`<span class="risk-text">${esc(match.risks[0])}</span>`:""}
        </div>
        <div class="card-actions">
          <button class="btn btn-ghost favorite-btn ${local.favorite?"active":""}" data-favorite="${esc(project.id)}">${local.favorite?"★ 已收藏":"☆ 收藏"}</button>
          <button class="btn btn-primary" data-detail="${esc(project.id)}">查看与跟进</button>
        </div>
      </div>
    </article>`;
  }).join("");

  document.querySelectorAll("[data-detail]").forEach(btn=>btn.addEventListener("click",()=>openDetail(btn.dataset.detail)));
  document.querySelectorAll("[data-favorite]").forEach(btn=>btn.addEventListener("click",()=>{
    const project = state.projects.find(p=>p.id===btn.dataset.favorite);
    if(!project) return;
    const local = getLocal(project);
    setLocal(project,{favorite:!local.favorite});
    applyFilters();
    toast(local.favorite?"已取消收藏":"已收藏");
  }));
}
function renderFocus(){
  const focus = [...state.filtered]
    .map(project=>({project,match:companyMatch(project)}))
    .filter(x=>x.match.score>=65)
    .sort((a,b)=>b.match.score-a.match.score)
    .slice(0,5);
  $("todayFocus").innerHTML = focus.length ? focus.map(({project,match})=>
    `<button class="focus-item focus-button" data-focus="${esc(project.id)}">
      <b>${esc(project.title)}</b>
      <span>${esc(project.region)} · ${esc(project.category)} · 公司匹配${match.score}分</span>
    </button>`
  ).join("") : '<div class="focus-item"><span>填写公司档案后显示重点项目</span></div>';
  document.querySelectorAll("[data-focus]").forEach(btn=>btn.addEventListener("click",()=>openDetail(btn.dataset.focus)));
}
function renderMonitor(){
  const monitor = state.monitor || {};
  const configured = !!monitor.channelConfigured;
  const pending = Number(monitor.pendingCount||0);
  const matched = Number(monitor.matchedProjectCount||0);
  const statusMap = {
    waiting:["等待运行","waiting"],ready:["监控正常","ok"],no_new:["监控正常","ok"],
    sent:["已推送","sent"],test_ok:["测试成功","sent"],not_configured:["待配置","warning"],
    pending:["待推送","warning"],error:["推送失败","error"],disabled:["已停用","error"]
  };
  const [label,cls] = statusMap[monitor.status] || ["状态未知","waiting"];
  $("monitorBadge").textContent = label;
  $("monitorBadge").className = `monitor-badge ${cls}`;
  $("monitorStatusText").textContent = monitor.statusText || "等待GitHub Actions首次运行";
  $("monitorLastCheck").textContent = monitor.lastCheckAt ? fmtDateTime(monitor.lastCheckAt) : "暂无";
  $("monitorChannel").textContent = configured ? "已连接" : "待配置";
  $("monitorMatched").textContent = matched;
  $("monitorPending").textContent = pending;
  const keywords = monitor.keywords || [];
  $("monitorKeywords").innerHTML = keywords.length
    ? keywords.slice(0,12).map(k=>`<span>${esc(k)}</span>`).join("")
    : "<span>等待配置</span>";
}
function renderCompany(){
  const c = state.company;
  $("companySummary").textContent = c.name
    ? `${c.name} · 已建立本地匹配档案`
    : "尚未填写公司档案，项目匹配分暂不启用";
  $("companyCategories").textContent = c.preferredCategories?.length ? c.preferredCategories.join("、") : "未设置";
  $("companyGuarantee").textContent = moneyLimit(c.maxGuaranteeWan);
  $("companyAdvance").textContent = moneyLimit(c.maxAdvanceWan);
}
function renderReminders(){
  const items = reminderItems();
  const deadlines = items.filter(x=>x.type==="deadline");
  $("reminderBadge").textContent = `${deadlines.length}项`;
  $("reminderBadge").className = `monitor-badge ${deadlines.some(x=>x.days<0)?"error":deadlines.length?"warning":"ok"}`;
  $("reminderList").innerHTML = items.length ? items.slice(0,8).map(item=>
    `<button class="reminder-item ${item.days!==null&&item.days<0?"overdue":""}" data-reminder="${esc(item.project.id)}">
      <b>${esc(item.project.title)}</b>
      <span>${item.type==="deadline"?"⏰ ":"→ "}${esc(item.text)}</span>
    </button>`
  ).join("") : '<div class="reminder-empty">当前没有待办。收藏项目并设置截止时间后会在这里显示。</div>';
  document.querySelectorAll("[data-reminder]").forEach(btn=>btn.addEventListener("click",()=>openDetail(btn.dataset.reminder)));
}

function openDetail(id){
  const project = state.projects.find(p=>p.id===id);
  if(!project) return;
  state.activeProject = project;
  const local = getLocal(project);
  const match = companyMatch(project);
  const due = deadlineValue(project);

  $("dialogCategory").textContent = `${project.region||"未知地区"} · ${project.category||"其他"}`;
  $("dialogTitle").textContent = project.title;
  $("dialogMeta").textContent = `发布日期${fmtDate(project.publishDate)} · 原适配评分${project.score||0}分 · 公司匹配${match.score||0}分`;
  $("dialogFacts").innerHTML = [
    ["预算/控制价",budgetText(project.budgetWan)],
    ["投标截止",due?fmtDateTime(due):"未识别"],
    ["招标人",project.tenderer||"未识别"],
    ["项目编号",project.projectCode||"未识别"],
    ["交易方式","公开招标"],
    ["数据来源",project.sourceName||"公共资源交易中心"]
  ].map(([k,v])=>`<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  $("dialogQualification").textContent = project.qualification || project.summary || "自动抓取尚未识别完整资格条件，请查看原公告与招标文件。";
  $("dialogCompanyMatch").innerHTML = `
    <div class="match-score ${match.tone}"><strong>${match.score||"—"}</strong><span>${esc(match.label)}</span></div>
    <div>
      <b>识别优势</b>
      <ul>${(match.strengths.length?match.strengths:["暂无明显优势"]).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>
      <b>需要核查</b>
      <ul>${(match.risks.length?match.risks:["暂未识别明显风险"]).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>
    </div>`;

  $("dialogStatus").value = local.status;
  $("dialogOwner").value = local.owner;
  $("dialogNextAction").value = local.nextAction;
  $("dialogCustomDeadline").value = toInputDateTime(local.customDeadline);
  $("dialogGuarantee").value = local.guaranteeWan;
  $("dialogAdvance").value = local.advanceWan;
  $("dialogNote").value = local.note;
  document.querySelectorAll("#dialogChecklist [data-task]").forEach(box=>{
    box.checked = !!local.checklist?.[box.dataset.task];
  });
  $("dialogFavorite").textContent = local.favorite ? "★ 取消收藏" : "☆ 收藏项目";
  $("dialogFavorite").classList.toggle("active",local.favorite);
  $("dialogSource").href = project.url || "#";
  $("detailDialog").showModal();
}
function saveActiveProject(){
  if(!state.activeProject) return;
  const checklist = {};
  document.querySelectorAll("#dialogChecklist [data-task]").forEach(box=>{
    checklist[box.dataset.task] = box.checked;
  });
  setLocal(state.activeProject,{
    status:$("dialogStatus").value,
    owner:$("dialogOwner").value.trim(),
    nextAction:$("dialogNextAction").value.trim(),
    customDeadline:$("dialogCustomDeadline").value,
    guaranteeWan:$("dialogGuarantee").value,
    advanceWan:$("dialogAdvance").value,
    checklist,
    note:$("dialogNote").value.trim()
  });
  $("detailDialog").close();
  applyFilters();
  checkBrowserNotices();
  toast("项目进度已保存");
}

function openCompany(){
  const c = state.company;
  $("companyNameInput").value = c.name || "";
  $("companyQualificationsInput").value = c.qualifications || "";
  $("companyPersonnelInput").value = c.personnel || "";
  $("companyPerformanceInput").value = c.performance || "";
  $("companyGuaranteeInput").value = c.maxGuaranteeWan || "";
  $("companyAdvanceInput").value = c.maxAdvanceWan || "";
  $("companyReminderDaysInput").value = (c.reminderDays||[7,3,1]).join(",");
  document.querySelectorAll("#companyCategoryChecks input").forEach(box=>{
    box.checked = (c.preferredCategories||[]).includes(box.value);
  });
  $("companyDialog").showModal();
}
function saveCompany(){
  const preferredCategories = [...document.querySelectorAll("#companyCategoryChecks input:checked")].map(x=>x.value);
  const reminderDays = $("companyReminderDaysInput").value
    .split(/[，,\s]+/).map(Number).filter(n=>Number.isFinite(n)&&n>=0&&n<=30);
  state.company = {
    name:$("companyNameInput").value.trim(),
    qualifications:$("companyQualificationsInput").value.trim(),
    personnel:$("companyPersonnelInput").value.trim(),
    performance:$("companyPerformanceInput").value.trim(),
    maxGuaranteeWan:$("companyGuaranteeInput").value,
    maxAdvanceWan:$("companyAdvanceInput").value,
    preferredCategories,
    reminderDays:reminderDays.length?[...new Set(reminderDays)].sort((a,b)=>b-a):[7,3,1]
  };
  saveJSON(COMPANY_STORE,state.company);
  $("companyDialog").close();
  applyFilters();
  checkBrowserNotices();
  toast("公司档案已保存");
}
function clearCompany(){
  if(!confirm("确定清空本浏览器中的公司档案吗？")) return;
  state.company = defaultCompany();
  saveJSON(COMPANY_STORE,state.company);
  $("companyDialog").close();
  applyFilters();
  toast("公司档案已清空");
}

function exportCsv(){
  if(!state.filtered.length){ toast("没有可导出的项目"); return; }
  const rows=[[
    "项目名称","地区","类别","发布日期","截止时间","预算万元","原适配评分","公司匹配分",
    "跟进状态","负责人","下一步","保证金万元","垫资万元","清单完成数","备注","原公告"
  ]];
  state.filtered.forEach(project=>{
    const local=getLocal(project);
    rows.push([
      project.title,project.region,project.category,project.publishDate||"",deadlineValue(project)||"",
      project.budgetWan||"",project.score||"",companyMatch(project).score||"",local.status,local.owner,
      local.nextAction,local.guaranteeWan,local.advanceWan,completedTaskCount(local),local.note,project.url
    ]);
  });
  const csv="\ufeff"+rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
  downloadBlob(csv,`招投标项目_${new Date().toISOString().slice(0,10)}.csv`,"text/csv;charset=utf-8");
}
function exportBackup(){
  const payload = {
    version:"1.3.0",exportedAt:new Date().toISOString(),
    company:state.company,userData:state.userData
  };
  downloadBlob(JSON.stringify(payload,null,2),`招投标看板备份_${new Date().toISOString().slice(0,10)}.json`,"application/json");
  toast("备份文件已导出");
}
function importBackup(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const payload = JSON.parse(reader.result);
      if(!payload || typeof payload!=="object") throw new Error("文件内容无效");
      if(payload.company && typeof payload.company==="object"){
        state.company = Object.assign(defaultCompany(),payload.company);
        saveJSON(COMPANY_STORE,state.company);
      }
      if(payload.userData && typeof payload.userData==="object"){
        state.userData = payload.userData;
        saveJSON(USER_STORE,state.userData);
      }
      $("backupDialog").close();
      applyFilters();
      toast("备份恢复成功");
    }catch(error){
      toast(`恢复失败：${error.message}`);
    }
  };
  reader.readAsText(file,"utf-8");
}
function downloadBlob(content,filename,type){
  const blob = new Blob([content],{type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url;a.download=filename;a.click();
  URL.revokeObjectURL(url);
}

async function requestNotification(){
  if(!("Notification" in window)){
    toast("当前浏览器不支持系统通知");
    return;
  }
  const result = await Notification.requestPermission();
  $("notifyBtn").textContent = result==="granted" ? "浏览器提醒已开启" : "开启浏览器提醒";
  toast(result==="granted" ? "浏览器提醒已开启" : "未获得通知权限");
  if(result==="granted") checkBrowserNotices(true);
}
function checkBrowserNotices(force=false){
  if(!("Notification" in window) || Notification.permission!=="granted") return;
  const leadDays = state.company.reminderDays || [7,3,1];
  trackedProjects().forEach(project=>{
    const value = deadlineValue(project);
    const days = daysTo(value);
    if(days===null || days<0 || !leadDays.includes(days)) return;
    const key = `${project.id}:${String(value).slice(0,16)}:${days}`;
    if(state.notices[key] && !force) return;
    const local = getLocal(project);
    new Notification(`招投标提醒：${days===0?"今天截止":`${days}天后截止`}`,{
      body:`${project.title}${local.nextAction?`\n下一步：${local.nextAction}`:""}`,
      tag:key
    });
    state.notices[key]=new Date().toISOString();
  });
  saveJSON(NOTICE_STORE,state.notices);
}

function bind(){
  $("searchInput").addEventListener("input",e=>{state.filters.search=e.target.value;applyFilters();});
  $("dateRange").addEventListener("change",e=>{state.filters.days=e.target.value;applyFilters();});
  $("sortSelect").addEventListener("change",e=>{state.filters.sort=e.target.value;applyFilters();});
  $("statusFilter").addEventListener("change",e=>{state.filters.status=e.target.value;applyFilters();});
  $("constructionOnly").addEventListener("change",e=>{state.filters.constructionOnly=e.target.checked;applyFilters();});
  $("favoriteOnly").addEventListener("change",e=>{state.filters.favoriteOnly=e.target.checked;applyFilters();});
  $("trackingOnly").addEventListener("change",e=>{state.filters.trackingOnly=e.target.checked;applyFilters();});
  $("refreshBtn").addEventListener("click",()=>location.reload());
  $("notifyBtn").addEventListener("click",requestNotification);
  $("companyBtn").addEventListener("click",openCompany);
  $("editCompanyBtn").addEventListener("click",openCompany);
  $("saveCompanyBtn").addEventListener("click",saveCompany);
  $("clearCompanyBtn").addEventListener("click",clearCompany);
  $("backupBtn").addEventListener("click",()=>$("backupDialog").showModal());
  $("exportBackupBtn").addEventListener("click",exportBackup);
  $("importBackupBtn").addEventListener("click",()=>$("importBackupFile").click());
  $("importBackupFile").addEventListener("change",e=>{
    const file=e.target.files?.[0];
    if(file) importBackup(file);
    e.target.value="";
  });
  $("exportBtn").addEventListener("click",exportCsv);
  $("dialogFavorite").addEventListener("click",()=>{
    if(!state.activeProject) return;
    const local=getLocal(state.activeProject);
    setLocal(state.activeProject,{favorite:!local.favorite});
    $("dialogFavorite").textContent = local.favorite?"☆ 收藏项目":"★ 取消收藏";
    $("dialogFavorite").classList.toggle("active",!local.favorite);
  });
  $("saveNoteBtn").addEventListener("click",saveActiveProject);
  $("resetBtn").addEventListener("click",()=>{
    state.filters.search="";state.filters.days="7";state.filters.sort="dateDesc";state.filters.status="all";
    state.filters.regions=new Set(state.config.defaultRegions||state.config.regions||[]);
    state.filters.categories=new Set(state.config.categories||["房建","市政","公路","水利"]);
    state.filters.constructionOnly=true;state.filters.favoriteOnly=false;state.filters.trackingOnly=false;
    $("searchInput").value="";$("dateRange").value="7";$("sortSelect").value="dateDesc";$("statusFilter").value="all";
    $("constructionOnly").checked=true;$("favoriteOnly").checked=false;$("trackingOnly").checked=false;
    renderFilterChips();applyFilters();
  });
  if("Notification" in window && Notification.permission==="granted"){
    $("notifyBtn").textContent="浏览器提醒已开启";
  }
}

let deferredPrompt;
window.addEventListener("beforeinstallprompt",event=>{
  event.preventDefault();deferredPrompt=event;$("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click",async()=>{
  if(!deferredPrompt)return;
  deferredPrompt.prompt();await deferredPrompt.userChoice;
  deferredPrompt=null;$("installBtn").classList.add("hidden");
});
if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
}

bind();
loadData().catch(error=>{
  console.error(error);
  $("updateStatus").textContent=`加载失败：${error.message}`;
  $("projectList").innerHTML='<div class="panel"><h3>数据加载失败</h3><p>请确认已完整上传data、assets等文件夹，并通过GitHub Pages访问。</p></div>';
});
})();