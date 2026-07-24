const $=id=>document.getElementById(id);
let activeFilter="all";
const cards=[...document.querySelectorAll(".tool-card")];

function toast(msg){
  const e=$("toast");e.textContent=msg;e.classList.remove("hidden");
  clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add("hidden"),1800);
}
function applyFilter(){
  const q=$("toolSearch").value.trim().toLowerCase();
  let visible=0;
  cards.forEach(card=>{
    const category=card.dataset.category||"";
    const keywords=(card.dataset.keywords||"")+" "+card.textContent;
    const okFilter=activeFilter==="all"||category.includes(activeFilter);
    const okSearch=!q||keywords.toLowerCase().includes(q);
    card.classList.toggle("hidden",!(okFilter&&okSearch));
    if(okFilter&&okSearch) visible++;
  });
  $("emptyState").classList.toggle("hidden",visible!==0);
}
$("toolSearch").addEventListener("input",applyFilter);
document.querySelectorAll(".filter").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll(".filter").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");activeFilter=btn.dataset.filter;applyFilter();
}));

async function loadStats(){
  try{
    const r=await fetch("apps/ruankao/data/version.json?v="+Date.now());
    const v=await r.json();
    $("questionCount").textContent=v.questionCount||"300";
    $("questionVersion").textContent="题库 "+(v.questionVersion||v.version||"V3.5");
    $("examCardCount").textContent=(v.questionCount||300)+"道选择题";
  }catch{
    $("questionCount").textContent="300";$("questionVersion").textContent="软考V3.5";$("examCardCount").textContent="300道选择题";
  }
  try{
    const [p,m]=await Promise.all([
      fetch("apps/tender/data/projects.json?v="+Date.now()).then(r=>r.json()),
      fetch("apps/tender/data/meta.json?v="+Date.now()).then(r=>r.json())
    ]);
    $("tenderCount").textContent=p.length;
    $("tenderCardCount").textContent=p.length+"个已收录项目";
    const d=m.updatedAt?new Date(m.updatedAt):null;
    $("tenderUpdated").textContent=d&&!isNaN(d)?("更新 "+d.toLocaleDateString("zh-CN")):"等待自动更新";
  }catch{
    $("tenderCount").textContent="—";$("tenderUpdated").textContent="打开模块查看";$("tenderCardCount").textContent="公开招标项目";
  }
}
const savedTheme=localStorage.getItem("toolboxTheme");
if(savedTheme==="dark"){document.documentElement.dataset.theme="dark";$("themeBtn").textContent="切换浅色";}
$("themeBtn").addEventListener("click",()=>{
  const dark=document.documentElement.dataset.theme==="dark";
  if(dark){delete document.documentElement.dataset.theme;localStorage.setItem("toolboxTheme","light");$("themeBtn").textContent="切换深色";}
  else{document.documentElement.dataset.theme="dark";localStorage.setItem("toolboxTheme","dark");$("themeBtn").textContent="切换浅色";}
});
let promptEvent;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();promptEvent=e;$("installBtn").classList.remove("hidden");});
$("installBtn").addEventListener("click",async()=>{if(!promptEvent)return;promptEvent.prompt();await promptEvent.userChoice;promptEvent=null;$("installBtn").classList.add("hidden");});
if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
loadStats();