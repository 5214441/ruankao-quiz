const $=id=>document.getElementById(id),KEY="hotelAssistantRecordsV1";let lastResult=null;
function n(id){return Number($(id).value)||0}function money(v){return "¥"+v.toLocaleString("zh-CN",{maximumFractionDigits:2})}
function toast(t){const e=$("toast");e.textContent=t;e.classList.remove("hidden");clearTimeout(toast.x);toast.x=setTimeout(()=>e.classList.add("hidden"),1600)}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));b.classList.add("active");$(b.dataset.tab).classList.add("active");if(b.dataset.tab==="history")renderHistory()});
function calcDaily(){
 const rooms=Math.max(1,n("rooms")),sold=Math.min(rooms,n("sold")),revenue=n("revenue"),commission=n("commission")/100,vc=n("variableCost"),fixed=n("fixedCost");
 const occ=sold/rooms,adr=sold?revenue/sold:0,revpar=revenue/rooms,net=revenue*(1-commission),profit=net-sold*vc-fixed;
 const contribution=adr*(1-commission)-vc,breakEven=contribution>0?Math.min(1,fixed/(rooms*contribution)):1;
 $("occupancy").textContent=(occ*100).toFixed(1)+"%";$("adr").textContent=money(adr);$("revpar").textContent=money(revpar);$("netRevenue").textContent=money(net);$("profit").textContent=money(profit);$("breakEven").textContent=(breakEven*100).toFixed(1)+"%";
 let advice=occ<.4?"入住率偏低：优先提高曝光和转化，不建议只靠大幅降门市价。":occ<.7?"入住率处于中段：可根据临近日期和竞品价小幅调整。":"入住率较高：应逐步收紧低价活动，保护最后库存收益。";
 if(profit<0) advice+="\n当前测算仍未覆盖固定成本，需要检查房价、佣金和变动成本。";
 lastResult={date:new Date().toISOString().slice(0,10),rooms,sold,revenue,occ,adr,revpar,profit};
 $("dailyAdvice").textContent=advice;
}
$("calcDaily").onclick=calcDaily;
$("saveDaily").onclick=()=>{if(!lastResult)calcDaily();const a=JSON.parse(localStorage.getItem(KEY)||"[]");a.unshift(lastResult);localStorage.setItem(KEY,JSON.stringify(a.slice(0,180)));toast("今日记录已保存")};
function calcPrice(){
 const base=n("basePrice"),occ=n("currentOcc")/100,comp=n("competitor"),lead=n("leadDays"),day=$("dayType").value,pos=$("position").value;
 let factor=1,reasons=[];
 if(occ>=.85){factor+=.16;reasons.push("入住率≥85%，提高尾房价格");}else if(occ>=.7){factor+=.08;reasons.push("入住率较高，适度提价");}else if(occ<.35){factor-=.10;reasons.push("入住率偏低，增强价格竞争力");}
 if(lead<=1&&occ<.6){factor-=.05;reasons.push("临近入住日且库存较多");}
 if(day==="weekend"){factor+=.06;reasons.push("周末需求加成");}if(day==="holiday"){factor+=.16;reasons.push("节假日/活动需求加成");}
 let target=base*factor;
 if(comp>0){const p=pos==="lower"?0.95:pos==="higher"?1.05:1;target=target*.45+comp*p*.55;reasons.push("综合参考竞品展示价");}
 target=Math.max(68,Math.round(target));
 $("suggestedPrice").textContent=money(target);$("priceRange").textContent=money(Math.round(target*.95))+" ～ "+money(Math.round(target*1.06));$("priceReasons").textContent=reasons.map(x=>"• "+x).join("\n");
}
$("calcPrice").onclick=calcPrice;
function renderHistory(){const a=JSON.parse(localStorage.getItem(KEY)||"[]");$("historyList").innerHTML=a.length?a.map(r=>`<div class="record"><div><b>${r.date}</b><small> ${r.sold}/${r.rooms}间</small></div><span>入住率 ${(r.occ*100).toFixed(1)}%</span><span>ADR ${money(r.adr)}</span><span>RevPAR ${money(r.revpar)}</span><span>利润 ${money(r.profit)}</span></div>`).join(""):"<p>暂无保存记录。</p>"}
$("clearHistory").onclick=()=>{if(confirm("确定清空本机酒店记录？")){localStorage.removeItem(KEY);renderHistory();toast("记录已清空")}};
$("exportBtn").onclick=()=>{const a=JSON.parse(localStorage.getItem(KEY)||"[]");if(!a.length)return toast("暂无记录");const rows=[["日期","总房间","已售","收入","入住率","ADR","RevPAR","利润"],...a.map(r=>[r.date,r.rooms,r.sold,r.revenue,(r.occ*100).toFixed(1),r.adr.toFixed(2),r.revpar.toFixed(2),r.profit.toFixed(2)])];const csv="\ufeff"+rows.map(x=>x.join(",")).join("\n");const u=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));const el=document.createElement("a");el.href=u;el.download="酒店经营记录.csv";el.click();URL.revokeObjectURL(u)};
calcDaily();calcPrice();