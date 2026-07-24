const DATA_URL = "data/projects.json";
const META_URL = "data/meta.json";
const CONFIG_URL = "config.json";
const STORE_KEY = "luanTenderBoardUserDataV1";

const state = {
  projects: [],
  meta: {},
  config: {},
  filtered: [],
  activeProject: null,
  userData: loadUserData(),
  filters: {
    search: "",
    days: "7",
    sort: "dateDesc",
    status: "all",
    regions: new Set(["霍邱县", "市直区"]),
    categories: new Set(["房建", "市政", "公路", "水利"]),
    constructionOnly: true,
    favoriteOnly: false
  }
};

const $ = (id) => document.getElementById(id);
const fmtDate = (value) => value ? new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(value)) : "未识别";
const fmtDateTime = (value) => value ? new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(value)) : "未识别";
const escapeHtml = (text="") => String(text).replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m]));

function loadUserData(){
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
}
function saveUserData(){
  localStorage.setItem(STORE_KEY, JSON.stringify(state.userData));
}
function getLocal(project){
  return state.userData[project.id] || {favorite:false,status:"未跟进",note:""};
}
function setLocal(project, patch){
  state.userData[project.id] = {...getLocal(project), ...patch};
  saveUserData();
}
function toast(message){
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(()=>el.classList.add("hidden"),2200);
}

async function loadData(){
  $("updateStatus").textContent = "正在读取最新数据…";
  const bust = `?v=${Date.now()}`;
  const [projectsRes, metaRes, configRes] = await Promise.all([
    fetch(DATA_URL+bust),
    fetch(META_URL+bust),
    fetch(CONFIG_URL+bust)
  ]);
  if(!projectsRes.ok) throw new Error("项目数据读取失败");
  state.projects = await projectsRes.json();
  state.meta = metaRes.ok ? await metaRes.json() : {};
  state.config = configRes.ok ? await configRes.json() : {};
  const defaults = state.config.defaultRegions || ["霍邱县","市直区"];
  state.filters.regions = new Set(defaults);
  renderFilterChips();
  applyFilters();
  const updated = state.meta.updatedAt ? fmtDateTime(state.meta.updatedAt) : "暂无";
  $("updateStatus").textContent = `数据更新时间：${updated} · 共收录 ${state.projects.length} 个项目`;
}

function renderFilterChips(){
  const regions = state.config.regions || [...new Set(state.projects.map(p=>p.region))];
  const categories = state.config.categories || ["房建","市政","公路","水利"];
  $("regionChips").innerHTML = regions.map(region =>
    `<button class="chip ${state.filters.regions.has(region)?"active":""}" data-region="${escapeHtml(region)}">${escapeHtml(region)}</button>`
  ).join("");
  $("categoryChips").innerHTML = categories.map(cat =>
    `<button class="chip ${state.filters.categories.has(cat)?"active":""}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
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
  const txt = `${project.title} ${project.type || ""}`;
  return /勘察|设计|监理|咨询|检测|审计|造价|全过程工程咨询/.test(txt) && !/EPC|总承包|施工/.test(txt);
}
function withinDays(dateString, days){
  if(days==="all") return true;
  const d = new Date(dateString);
  if(Number.isNaN(d.getTime())) return true;
  const now = new Date();
  const diff = (now - d) / 86400000;
  return diff >= -1 && diff <= Number(days);
}
function daysToDeadline(value){
  if(!value) return null;
  const diff = (new Date(value) - new Date()) / 86400000;
  return Math.ceil(diff);
}
function applyFilters(){
  const f = state.filters;
  const keyword = f.search.trim().toLowerCase();

  let result = state.projects.filter(project => {
    const local = getLocal(project);
    const haystack = [
      project.title, project.region, project.category, project.summary,
      project.qualification, project.projectCode, project.tenderer
    ].join(" ").toLowerCase();

    if(keyword && !haystack.includes(keyword)) return false;
    if(f.regions.size && !f.regions.has(project.region)) return false;
    if(f.categories.size && !f.categories.has(project.category)) return false;
    if(!withinDays(project.publishDate, f.days)) return false;
    if(f.constructionOnly && isPureService(project)) return false;
    if(f.favoriteOnly && !local.favorite) return false;
    if(f.status !== "all" && local.status !== f.status) return false;
    return true;
  });

  result.sort((a,b)=>{
    if(f.sort==="scoreDesc") return (b.score||0)-(a.score||0);
    if(f.sort==="deadlineAsc"){
      const ad=a.deadline?new Date(a.deadline).getTime():Infinity;
      const bd=b.deadline?new Date(b.deadline).getTime():Infinity;
      return ad-bd;
    }
    if(f.sort==="budgetDesc") return (b.budgetWan||0)-(a.budgetWan||0);
    return new Date(b.publishDate)-new Date(a.publishDate);
  });

  state.filtered = result;
  renderAll();
}

function renderAll(){
  renderMetrics();
  renderProjects();
  renderFocus();
}
function renderMetrics(){
  const today = new Date().toISOString().slice(0,10);
  const todayCount = state.filtered.filter(p => String(p.publishDate).slice(0,10)===today).length;
  const deadlineCount = state.filtered.filter(p => {
    const d = daysToDeadline(p.deadline);
    return d!==null && d>=0 && d<=7;
  }).length;
  const high = state.filtered.filter(p=>(p.score||0)>=80).length;
  $("metricTotal").textContent = state.filtered.length;
  $("metricToday").textContent = todayCount;
  $("metricDeadline").textContent = deadlineCount;
  $("metricHigh").textContent = high;
  $("resultText").textContent = `当前显示 ${state.filtered.length} 个项目，原始数据 ${state.projects.length} 个`;
}
function scoreClass(score){
  if(score>=80) return "score-high";
  if(score>=65) return "score-medium";
  return "";
}
function scoreLabel(score){
  if(score>=80) return "高匹配";
  if(score>=65) return "可关注";
  return "一般";
}
function deadlineText(value){
  const days = daysToDeadline(value);
  if(days===null) return "截止时间未识别";
  if(days<0) return `已截止 ${Math.abs(days)} 天`;
  if(days===0) return "今天截止";
  return `${days} 天后截止`;
}
function budgetText(value){
  if(!value) return "未识别";
  return `${Number(value).toLocaleString("zh-CN",{maximumFractionDigits:4})} 万元`;
}
function renderProjects(){
  const container = $("projectList");
  $("emptyState").classList.toggle("hidden", state.filtered.length!==0);
  container.innerHTML = state.filtered.map(project => {
    const local = getLocal(project);
    const deadline = deadlineText(project.deadline);
    const deadlineBadge = project.deadline && daysToDeadline(project.deadline)<=7 && daysToDeadline(project.deadline)>=0 ? "red" : "amber";
    return `<article class="project-card ${scoreClass(project.score||0)}">
      <div class="project-top">
        <div>
          <div class="badges">
            <span class="badge blue">${escapeHtml(project.region||"未知地区")}</span>
            <span class="badge">${escapeHtml(project.category||"其他")}</span>
            ${project.isSecond ? '<span class="badge amber">二次招标</span>' : ''}
            ${project.isEpc ? '<span class="badge green">EPC</span>' : ''}
            ${project.deadline ? `<span class="badge ${deadlineBadge}">${escapeHtml(deadline)}</span>` : ""}
          </div>
          <h3 class="project-title">${escapeHtml(project.title)}</h3>
        </div>
        <div class="score-box">
          <strong>${project.score||0}</strong>
          <span>${scoreLabel(project.score||0)}</span>
        </div>
      </div>

      <div class="project-meta">
        <span>发布日期：<b>${fmtDate(project.publishDate)}</b></span>
        <span>预算/控制价：<b>${budgetText(project.budgetWan)}</b></span>
        <span>截止时间：<b>${project.deadline ? fmtDateTime(project.deadline) : "未识别"}</b></span>
      </div>

      <p class="summary">${escapeHtml(project.summary || "请进入原公告查看项目概况、资质要求、评标办法和投标截止时间。")}</p>

      <div class="project-footer">
        <div class="local-state">
          <span class="status-pill">${escapeHtml(local.status)}</span>
          ${local.note ? '<span class="badge green">已备注</span>' : ''}
        </div>
        <div class="card-actions">
          <button class="btn btn-ghost favorite-btn ${local.favorite?"active":""}" data-favorite="${escapeHtml(project.id)}">${local.favorite?"★ 已收藏":"☆ 收藏"}</button>
          <button class="btn btn-primary" data-detail="${escapeHtml(project.id)}">查看详情</button>
        </div>
      </div>
    </article>`;
  }).join("");

  document.querySelectorAll("[data-detail]").forEach(btn => btn.addEventListener("click",()=>openDetail(btn.dataset.detail)));
  document.querySelectorAll("[data-favorite]").forEach(btn => btn.addEventListener("click",()=>{
    const project = state.projects.find(p=>p.id===btn.dataset.favorite);
    const local = getLocal(project);
    setLocal(project,{favorite:!local.favorite});
    applyFilters();
    toast(local.favorite ? "已取消收藏" : "已收藏");
  }));
}
function renderFocus(){
  const focus = [...state.filtered]
    .filter(p=>(p.score||0)>=75)
    .sort((a,b)=>(b.score||0)-(a.score||0))
    .slice(0,5);
  $("todayFocus").innerHTML = focus.length ? focus.map(p =>
    `<div class="focus-item">
      <b>${escapeHtml(p.title)}</b>
      <span>${escapeHtml(p.region)} · ${escapeHtml(p.category)} · ${p.score}分</span>
    </div>`
  ).join("") : '<div class="focus-item"><span>当前筛选没有高匹配项目</span></div>';
}

function openDetail(id){
  const project = state.projects.find(p=>p.id===id);
  if(!project) return;
  state.activeProject = project;
  const local = getLocal(project);
  $("dialogCategory").textContent = `${project.region} · ${project.category}`;
  $("dialogTitle").textContent = project.title;
  $("dialogMeta").textContent = `发布日期 ${fmtDate(project.publishDate)} · 适配评分 ${project.score||0} 分 · ${scoreLabel(project.score||0)}`;
  $("dialogFacts").innerHTML = [
    ["预算/控制价",budgetText(project.budgetWan)],
    ["投标截止",project.deadline?fmtDateTime(project.deadline):"未识别"],
    ["招标人",project.tenderer||"未识别"],
    ["项目编号",project.projectCode||"未识别"],
    ["交易方式","公开招标"],
    ["数据来源",project.sourceName||"六安市公共资源交易中心"]
  ].map(([k,v])=>`<div class="fact"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join("");
  $("dialogQualification").textContent = project.qualification || project.summary || "自动抓取尚未识别完整资格条件，请查看原公告与招标文件。";
  $("dialogStatus").value = local.status;
  $("dialogNote").value = local.note;
  $("dialogFavorite").textContent = local.favorite ? "★ 取消收藏" : "☆ 收藏项目";
  $("dialogFavorite").classList.toggle("active",local.favorite);
  $("dialogSource").href = project.url;
  $("detailDialog").showModal();
}
$("dialogFavorite").addEventListener("click",()=>{
  if(!state.activeProject) return;
  const local = getLocal(state.activeProject);
  setLocal(state.activeProject,{favorite:!local.favorite});
  $("dialogFavorite").textContent = local.favorite ? "☆ 收藏项目" : "★ 取消收藏";
  $("dialogFavorite").classList.toggle("active",!local.favorite);
});
$("saveNoteBtn").addEventListener("click",()=>{
  if(!state.activeProject) return;
  setLocal(state.activeProject,{
    status:$("dialogStatus").value,
    note:$("dialogNote").value.trim()
  });
  $("detailDialog").close();
  applyFilters();
  toast("跟进记录已保存");
});

function bindFilters(){
  $("searchInput").addEventListener("input",e=>{state.filters.search=e.target.value;applyFilters();});
  $("dateRange").addEventListener("change",e=>{state.filters.days=e.target.value;applyFilters();});
  $("sortSelect").addEventListener("change",e=>{state.filters.sort=e.target.value;applyFilters();});
  $("statusFilter").addEventListener("change",e=>{state.filters.status=e.target.value;applyFilters();});
  $("constructionOnly").addEventListener("change",e=>{state.filters.constructionOnly=e.target.checked;applyFilters();});
  $("favoriteOnly").addEventListener("change",e=>{state.filters.favoriteOnly=e.target.checked;applyFilters();});
  $("refreshBtn").addEventListener("click",()=>location.reload());
  $("resetBtn").addEventListener("click",()=>{
    state.filters.search="";
    state.filters.days="7";
    state.filters.sort="dateDesc";
    state.filters.status="all";
    state.filters.regions=new Set(state.config.defaultRegions||["霍邱县","市直区"]);
    state.filters.categories=new Set(state.config.categories||["房建","市政","公路","水利"]);
    state.filters.constructionOnly=true;
    state.filters.favoriteOnly=false;
    $("searchInput").value="";
    $("dateRange").value="7";
    $("sortSelect").value="dateDesc";
    $("statusFilter").value="all";
    $("constructionOnly").checked=true;
    $("favoriteOnly").checked=false;
    renderFilterChips();
    applyFilters();
  });
  $("exportBtn").addEventListener("click",exportCsv);
}
function exportCsv(){
  if(!state.filtered.length){toast("没有可导出的项目");return;}
  const rows=[["项目名称","地区","类别","发布日期","截止时间","预算万元","适配评分","跟进状态","备注","原公告"]];
  state.filtered.forEach(p=>{
    const local=getLocal(p);
    rows.push([p.title,p.region,p.category,p.publishDate||"",p.deadline||"",p.budgetWan||"",p.score||"",local.status,local.note,p.url]);
  });
  const csv="\ufeff"+rows.map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=`招投标项目_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

let deferredPrompt;
window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault();
  deferredPrompt=e;
  $("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click",async()=>{
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt=null;
  $("installBtn").classList.add("hidden");
});
if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
}

bindFilters();
loadData().catch(err=>{
  console.error(err);
  $("updateStatus").textContent = `加载失败：${err.message}`;
  $("projectList").innerHTML = `<div class="panel"><h3>数据加载失败</h3><p>请确认已完整上传 data、assets 等文件夹，并通过 GitHub Pages 访问。</p></div>`;
});
