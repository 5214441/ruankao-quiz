const $=id=>document.getElementById(id);
let activeFilter="all";
const cards=[...document.querySelectorAll("a.tool-card")];
function setText(id,value){const e=$(id);if(e)e.textContent=value}
function applyFilter(){const q=($("toolSearch")?.value||"").trim().toLowerCase();let visible=0;cards.forEach(card=>{const category=card.dataset.category||"";const keywords=((card.dataset.keywords||"")+" "+card.textContent).toLowerCase();const show=(activeFilter==="all"||category.includes(activeFilter))&&(!q||keywords.includes(q));card.classList.toggle("hidden",!show);if(show)visible++});$("emptyState")?.classList.toggle("hidden",visible!==0)}
$("toolSearch")?.addEventListener("input",applyFilter);
document.querySelectorAll(".filter").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll(".filter").forEach(item=>item.classList.remove("active"));button.classList.add("active");activeFilter=button.dataset.filter||"all";applyFilter()}));
async function fetchJson(url){const r=await fetch(url,{cache:"no-store"});if(!r.ok)throw new Error(`${url} ${r.status}`);return r.json()}
async function loadStats(){try{const v=await fetchJson("apps/ruankao/data/version.json?v="+Date.now());const count=v.questionCount||300;setText("questionCount",count);setText("questionVersion","题库 "+(v.questionVersion||v.version||"V3.5"));setText("examCardCount",count+"道选择题")}catch{setText("questionCount","300");setText("questionVersion","智能备考");setText("examCardCount","300道选择题")}try{const [p,m]=await Promise.all([fetchJson("apps/tender/data/projects.json?v="+Date.now()),fetchJson("apps/tender/data/meta.json?v="+Date.now())]);const count=Array.isArray(p)?p.length:0;setText("tenderCount",count);setText("tenderCardCount",count+"个已收录项目");const d=m.updatedAt?new Date(m.updatedAt):null;setText("tenderUpdated",d&&!Number.isNaN(d.getTime())?"更新 "+d.toLocaleDateString("zh-CN"):"等待自动更新")}catch{setText("tenderCount","—");setText("tenderUpdated","打开项目查看");setText("tenderCardCount","公开招标项目")}}
function applyTheme(theme){const dark=theme==="dark";if(dark)document.documentElement.dataset.theme="dark";else delete document.documentElement.dataset.theme;const text=document.querySelector(".theme-text");if(text)text.textContent=dark?"浅色模式":"深色模式"}
applyTheme(localStorage.getItem("toolboxTheme")==="dark"?"dark":"light");
$("themeBtn")?.addEventListener("click",()=>{const next=document.documentElement.dataset.theme==="dark"?"light":"dark";localStorage.setItem("toolboxTheme",next);applyTheme(next)});
let installPrompt;window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();installPrompt=event;$("installBtn")?.classList.remove("hidden")});$("installBtn")?.addEventListener("click",async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$("installBtn").classList.add("hidden")});
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js?v=1.2.0").catch(()=>{}));
loadStats();
