(function(){
'use strict';
const $=id=>document.getElementById(id);let current=[],valid=[],candidate=[];
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function download(obj,name){const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function loadCurrent(){try{const r=await fetch('data/questions.json');current=await r.json();}catch(e){alert('当前题库加载失败，请通过GitHub Pages或本地HTTP服务器打开。');}}
function normalizeInput(x){if(Array.isArray(x))return x;if(x&&Array.isArray(x.questions))return x.questions;throw new Error('JSON中没有题目数组');}
function validateQuestion(q,index,existingIds,existingTexts,batchIds,batchTexts){const errors=[],prefix=`第${index+1}题`;
  if(!q||typeof q!=='object')return [`${prefix}：不是对象`];
  if(!q.id||typeof q.id!=='string')errors.push(`${prefix}：缺少字符串ID`);else if(existingIds.has(q.id)||batchIds.has(q.id))errors.push(`${prefix}：ID重复 ${q.id}`);
  if(!q.text||typeof q.text!=='string'||q.text.trim().length<5)errors.push(`${prefix}：题干过短或缺失`);else{const t=q.text.trim();if(existingTexts.has(t)||batchTexts.has(t))errors.push(`${prefix}：题干完全重复`);}
  if(!Array.isArray(q.options)||q.options.length!==4||q.options.some(x=>typeof x!=='string'||!x.trim()))errors.push(`${prefix}：必须有4个非空选项`);
  if(!Number.isInteger(q.answer)||q.answer<0||q.answer>3)errors.push(`${prefix}：answer必须为0—3整数`);
  if(!q.explanation||typeof q.explanation!=='string'||q.explanation.trim().length<5)errors.push(`${prefix}：缺少有效解析`);
  if(!q.category||!q.knowledge)errors.push(`${prefix}：缺少category或knowledge`);
  if(![1,2,3].includes(Number(q.difficulty)))errors.push(`${prefix}：difficulty必须为1、2或3`);
  if(!['concept','scenario','calculation'].includes(q.type))errors.push(`${prefix}：type必须为concept、scenario或calculation`);
  return errors;
}
function validate(){let parsed;try{parsed=normalizeInput(JSON.parse($('candidateText').value));}catch(e){alert(`候选题JSON无效：${e.message}`);return;}candidate=parsed;const existingIds=new Set(current.map(q=>q.id)),existingTexts=new Set(current.map(q=>q.text.trim())),batchIds=new Set(),batchTexts=new Set(),errors=[];valid=[];
  candidate.forEach((q,i)=>{const es=validateQuestion(q,i,existingIds,existingTexts,batchIds,batchTexts);if(es.length)errors.push(...es);else{valid.push(q);batchIds.add(q.id);batchTexts.add(q.text.trim());}});
  $('resultCard').classList.remove('hidden');$('resultTag').textContent=`有效 ${valid.length} / ${candidate.length}`;$('resultTag').className=`tag ${errors.length?'warn':'ok'}`;
  $('resultSummary').innerHTML=`<div class="grid3"><div class="metric"><small>候选题</small><strong>${candidate.length}</strong></div><div class="metric"><small>有效新题</small><strong>${valid.length}</strong></div><div class="metric"><small>问题数量</small><strong>${errors.length}</strong></div></div><div class="callout ${valid.length>=10?'ok':'warn'}" style="margin-top:12px"><b>${valid.length>=10?'满足自动合并条件':'不足10道有效新题'}</b><div class="small">GitHub Actions默认只有达到10道有效新题时才自动合并。</div></div>`;
  $('errorList').innerHTML=errors.length?`<h3>问题明细</h3>${errors.slice(0,100).map(e=>`<div class="review wrong-text">${esc(e)}</div>`).join('')}`:'<div class="callout ok" style="margin-top:12px">结构校验全部通过。发布前仍建议人工抽查答案和解析。</div>';
  $('downloadValid').disabled=!valid.length;$('downloadMerged').disabled=valid.length<1;
}
$('candidateFile').onchange=function(){const f=this.files&&this.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{$('candidateText').value=r.result;};r.readAsText(f);};
$('validateBtn').onclick=validate;$('downloadValid').onclick=()=>download(valid,`valid-questions-${new Date().toISOString().slice(0,10)}.json`);$('downloadMerged').onclick=()=>download(current.concat(valid),`questions-merged-${current.length+valid.length}.json`);
loadCurrent();
})();
