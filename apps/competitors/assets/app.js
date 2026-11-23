(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[c]);
  const validNumber = x => typeof x === "number" && Number.isFinite(x) && x > 0;
  const safeURL = url => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && u.hostname === "ggzy.luan.gov.cn" ? u.href : "";
    } catch { return ""; }
  };
  const source = (url, label = "查看官方来源 ↗") => {
    const href = safeURL(url);
    return href ? '<a class="source" href="' + esc(href) +
      '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>' : "";
  };
  const money = v => validNumber(v)
    ? (v >= 10000 ? (v / 10000).toLocaleString("zh-CN", {maximumFractionDigits: 4}) + " 万元"
      : v.toLocaleString("zh-CN", {maximumFractionDigits: 2}) + " 元")
    : "未核实";
  const timeText = s => String(s || "").replace("T", " ").slice(0, 19) || "未公开";
  const normalize = s => String(s || "").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
  const pageSize = 28;
  const state = {data: {projects:[], bids:[], companies:[], meta:{}}, tab:"overview", q:"", category:"", region:"", range:"all", limit:pageSize};

  function filters(p) {
    if (state.region && p.region !== state.region) return false;
    if (state.category && p.category !== state.category) return false;
    if (state.range !== "all") {
      const d = Date.parse(p.publishDate || "");
      if (!Number.isFinite(d) || (Date.now() - d) / 86400000 > Number(state.range)) return false;
    }
    if (state.q) {
      const text = [p.title,p.projectCode,p.segmentCode,p.region,p.category,p.winner,
        ...(p.quotes || []).map(x => x.bidder)].join(" ").toLowerCase();
      if (!text.includes(state.q)) return false;
    }
    return true;
  }

  function visibleProjects() { return state.data.projects.filter(filters); }
  function visibleBidRows() {
    const ids = new Set(visibleProjects().map(p=>p.id));
    return state.data.bids.filter(b => ids.has(b.projectId));
  }
  function recordHeader(p) {
    const label = p.kind === "opening" ? "开评标" : p.kind === "candidate" ? "候选人" : "中标结果";
    return '<div class="meta"><span>' + esc(label) + '</span><span>' + esc(p.region || "未识别") +
      '</span><span>' + esc(p.category || "其他") + '</span><span>' +
      esc(p.publishDate || "日期未知") + '</span></div>';
  }
  function recordCard(p, detail = true) {
    const quotes = (p.quotes || []).slice(0, 7).map(q =>
      '<div class="quote"><span class="bidder">' + esc(q.bidder) +
      '</span><strong>' + (validNumber(q.bidYuan) ? money(q.bidYuan) : "价格未核实") +
      '</strong></div>'
    ).join("");
    const extra = (p.quotes || []).length > 7
      ? '<div class="summary">另有 ' + ((p.quotes || []).length-7) + ' 条报价，请查看官方原始记录。</div>' : "";
    const outcome = p.kind === "result"
      ? '<div class="summary">正式中标单位：<b>' + esc(p.winner || "未可靠识别") +
        '</b>　中标金额：<b>' + money(p.winningYuan) + '</b></div>'
      : p.winner ? '<div class="summary">关联结果公示的中标单位：' + esc(p.winner) + '</div>' : "";
    return '<article class="record">' +
      recordHeader(p) + '<h3>' + esc(p.title) + '</h3>' +
      '<div class="summary">项目编号：' + esc(p.projectCode || "未识别") +
      '　标段编号：' + esc(p.segmentCode || "未识别") + '</div>' +
      (p.openingTime ? '<div class="summary">开标时间：' + esc(p.openingTime) + '</div>' : "") +
      outcome +
      (detail && p.kind === "opening" ?
        '<div class="sublist">' + (quotes || '<div class="summary">本页未识别到有效投标人列表。</div>') + extra + '</div>' : "") +
      '<div class="record-footer">' + source(p.url) +
      (p.resultSourceUrl ? source(p.resultSourceUrl, "查看关联中标结果 ↗") : "") + '</div>' +
      '</article>';
  }
  function paginator(items, target, card, emptyText) {
    const visible = items.slice(0, state.limit);
    target.innerHTML = visible.length ? visible.map(card).join("") :
      '<div class="empty">' + esc(emptyText) + '</div>';
    if (items.length > state.limit) {
      const wrap = document.createElement("div");
      wrap.className = "pager";
      const btn = document.createElement("button");
      btn.textContent = '继续显示（已显示 ' + state.limit + ' / ' + items.length + '）';
      btn.onclick = () => { state.limit += pageSize; render(); };
      wrap.appendChild(btn);
      target.appendChild(wrap);
    }
  }
  function barRows(values, target) {
    const max = Math.max(1, ...values.map(x => x[1]));
    target.innerHTML = values.length ? values.map(([label, value]) =>
      '<div class="bar-row"><span>' + esc(label) +
      '</span><div class="bar-track"><div class="bar-fill" style="width:' +
      Math.max(1, Math.round(value / max * 100)) +
      '%"></div></div><strong>' + value + '</strong></div>').join("") :
      '<div class="empty">暂无有效样本</div>';
  }
  function renderOverview(projects, bids) {
    const counts = new Map();
    projects.forEach(p => counts.set(p.category, (counts.get(p.category) || 0) + 1));
    barRows([...counts].sort((a,b)=>b[1]-a[1]), $("categoryChart"));
    const comp = new Map();
    bids.forEach(b => {
      const key = normalize(b.bidder);
      if (key) comp.set(key, {name:b.bidder, count:(comp.get(key)?.count || 0) + 1});
    });
    const sorted = [...comp.values()].sort((a,b)=>b.count-a.count).slice(0,8);
    $("topCompanies").innerHTML = sorted.length ? sorted.map((x,i)=>
      '<div class="leader"><span class="rank">' + (i+1) + '</span><span class="name">' +
      esc(x.name) + '</span><span class="count">' + x.count + ' 条报价记录</span></div>').join("") :
      '<div class="empty">暂无可统计的投标企业</div>';
    paginator(projects.slice(0,120), $("recentRecords"), p=>recordCard(p,false), "暂无公开记录，首次采集尚未完成。");
  }
  function renderCompanies(bids) {
    const grouped = new Map();
    bids.forEach(b=>{
      const key = normalize(b.bidder);
      if (!key) return;
      if (!grouped.has(key)) grouped.set(key, {name:b.bidder, projects:new Set(), valid:0, examples:[]});
      const g=grouped.get(key);
      g.projects.add(b.projectId);
      if (validNumber(b.bidYuan)) g.valid++;
      g.examples.push(b);
    });
    const list=[...grouped.values()].sort((a,b)=>b.projects.size-a.projects.size || a.name.localeCompare(b.name,"zh"));
    $("companyCount").textContent = list.length + " 个公开样本主体";
    paginator(list,$("companyRecords"), g=>
      '<article class="company"><h3>' + esc(g.name) + '</h3><div class="company-grid">' +
      '<div><span>参与项目数</span><b>'+g.projects.size+'</b></div>' +
      '<div><span>公开报价条数</span><b>'+g.examples.length+'</b></div>' +
      '<div><span>有效金额报价</span><b>'+g.valid+'</b></div></div>' +
      '<div class="summary">' + esc(g.examples[0]?.project || "") + '</div>' +
      source(g.examples[0]?.sourceUrl, "最近样本原公告 ↗") + '</article>',
      "当前筛选条件下暂无企业记录。");
  }
  function updateCompareOptions() {
    const choices = state.data.companies.map(c=>c.name).sort((a,b)=>a.localeCompare(b,"zh"));
    for(const el of [$("compareA"), $("compareB")]) {
      const previous = el.value;
      el.innerHTML = '<option value="">选择企业</option>' +
        choices.map((name,i)=>'<option value="'+i+'">'+esc(name)+'</option>').join("");
      const found = choices.indexOf(previous);
      if (found >= 0) el.value = String(found);
    }
    state.companyChoices = choices;
  }
  function renderCompare() {
    const a=state.companyChoices?.[Number($("compareA").value)];
    const b=state.companyChoices?.[Number($("compareB").value)];
    // 空字符串不能被 Number() 当作企业0
    if ($("compareA").value === "" || $("compareB").value === "" || !a || !b) {
      $("comparison").className = "compare-empty";
      $("comparison").textContent = "请选择两家企业，进行公开样本比较。";
      return;
    }
    const observations = state.data.bids;
    const stats = name => {
      const matched=observations.filter(x=>normalize(x.bidder)===normalize(name));
      const official=new Set(matched.map(x=>x.projectId));
      return [official.size,matched.length,matched.filter(x=>validNumber(x.bidYuan)).length];
    };
    const ax=stats(a), bx=stats(b);
    $("comparison").className = "";
    const headers=["公开参与项目","报价记录数量","有效金额报价"];
    $("comparison").innerHTML = '<table class="comparison-table"><thead><tr><th>公开样本指标</th><th>' +
      esc(a)+'</th><th>'+esc(b)+'</th></tr></thead><tbody>' +
      headers.map((label,i)=>'<tr><th>'+esc(label)+'</th><td>'+ax[i]+'</td><td>'+bx[i]+'</td></tr>').join("") +
      '</tbody></table>';
  }
  function render() {
    const projects = visibleProjects(), bids=visibleBidRows();
    $("sProjects").textContent = projects.length.toLocaleString();
    $("sBids").textContent = bids.length.toLocaleString();
    $("sCompanies").textContent = new Set(bids.map(x=>normalize(x.bidder)).filter(Boolean)).size.toLocaleString();
    $("sValid").textContent = bids.filter(x=>validNumber(x.bidYuan)).length.toLocaleString();
    renderOverview(projects,bids);
    const openings=projects.filter(x=>x.kind==="opening");
    $("openingCount").textContent=openings.length+" 条开标公开记录";
    paginator(openings,$("openingRecords"),p=>recordCard(p,true),"当前没有匹配的开标记录。");
    renderCompanies(bids);
    const awards=projects.filter(p=>p.kind==="result");
    $("awardCount").textContent=awards.length+" 条结果公告";
    paginator(awards,$("awardRecords"),p=>recordCard(p,false),"当前没有匹配的中标结果。");
    renderCompare();
  }
  function createFilters() {
    for(const [key,selector] of [["region","region"],["category","category"]]) {
      const values = [...new Set(state.data.projects.map(p=>p[key]).filter(Boolean))].sort();
      $(selector).innerHTML = '<option value="">所有'+(key==="region"?"地区":"类别")+'</option>' +
        values.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("");
      $(selector).value="";
    }
  }
  function exportCsv() {
    const projects=visibleProjects();
    const headers=["项目名称","类型","地区","类别","项目编号","标段编号","日期","公开投标单位数量","正式中标单位","中标金额元","原公告"];
    const rows=projects.map(p=>[p.title,p.kind,p.region,p.category,p.projectCode,p.segmentCode,
      p.publishDate,(p.quotes||[]).length,p.winner,p.winningYuan ?? "",p.url]);
    const csv=[headers,...rows].map(row=>row.map(v=>{
      const s=String(v??"");
      const safe=/^[=+\-@\t\r]/.test(s)?"'"+s:s; // 防止表格公式注入
      return '"'+safe.replace(/"/g,'""')+'"';
    }).join(",")).join("\r\n");
    const blob=new Blob(["\ufeff",csv],{type:"text/csv;charset=utf-8"});
    const link=document.createElement("a");link.href=URL.createObjectURL(blob);
    link.download="KK_招投标竞争情报_"+new Date().toISOString().slice(0,10)+".csv";
    link.click();setTimeout(()=>URL.revokeObjectURL(link.href),500);
  }
  document.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{
    state.tab=b.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach(x=>x.classList.toggle("active",x===b));
    document.querySelectorAll(".panel").forEach(x=>x.classList.toggle("active",x.id==="view-"+state.tab));
  }));
  for(const key of ["q","category","region","range"]) {
    $(key).addEventListener(key==="q"?"input":"change", e=>{
      state[key]=String(e.target.value||"").trim().toLowerCase();
      state.limit=pageSize;
      render();
    });
  }
  for(const id of ["compareA","compareB"])$(id).addEventListener("change",renderCompare);
  $("exportCsv").addEventListener("click",exportCsv);

  fetch("data/records.json?v="+Date.now(),{cache:"no-store"})
    .then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.json();})
    .then(data=>{
      if (!Array.isArray(data.projects)||!Array.isArray(data.bids)||!Array.isArray(data.companies))throw Error("数据格式错误");
      state.data=data;
      $("lastUpdate").textContent="最新采集："+timeText(data.meta?.updatedAt);
      $("coverage").textContent=data.meta?.coverage || "仅展示已核实的公开项目，不代表全部投标活动。";
      if (!data.projects.length) {
        $("loadError").hidden=false;
        $("loadError").textContent="首次采集尚未产出正式记录。看板已就绪，但没有将演示数据冒充真实报价。";
      }
      createFilters();
      updateCompareOptions();
      render();
    })
    .catch(error=>{
      $("loadError").hidden=false;
      $("loadError").textContent="公开数据读取失败："+error.message+"；不会显示虚构的统计结果。";
      $("lastUpdate").textContent="数据读取失败";
      render();
    });
})();
