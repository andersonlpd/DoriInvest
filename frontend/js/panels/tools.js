import {money,compactMoney,notify} from '../dom.js';
import {futureValue,requiredMonthly,computeRanking} from '../calc.js';
import {INDICATOR_HELP} from '../help.js';
function renderCalculators() {
  const initial = Number(document.getElementById('calc-initial').value),
    monthly = Number(document.getElementById('calc-monthly').value),
    rate = Number(document.getElementById('calc-rate').value),
    years = Number(document.getElementById('calc-years').value);
  if ([initial, monthly, rate, years].every(Number.isFinite) && initial >= 0 && monthly >= 0 && rate >= 0 && years > 0) {
    document.getElementById('calc-result').textContent = money(futureValue(initial, monthly, rate, years));
    document.getElementById('calc-invested').textContent = 'Aportes no período: ' + money(initial + monthly * Math.round(years * 12));
    document.getElementById('calc-million-monthly').textContent = money(requiredMonthly(1000000, initial, rate, years));
  }
  const target = Number(document.getElementById('dividend-target').value),
    yieldRate = Number(document.getElementById('dividend-yield').value);
  if (target > 0 && yieldRate > 0) document.getElementById('dividend-capital').textContent = money(target * 12 / (yieldRate / 100));
  const expenses = Number(document.getElementById('reserve-expenses').value),
    months = Number(document.getElementById('reserve-months').value);
  if (expenses > 0 && months > 0) document.getElementById('reserve-target').textContent = money(expenses * months);
}
let rankingRows=null;
function fillRankingSectors(rows){const setor=document.getElementById('ranking-setor');if(!setor||setor.options.length>1)return;const unique=[...new Set(rows.map(r=>r.setor).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));unique.forEach(name=>{const option=document.createElement('option');option.value=name;option.textContent=name;setor.append(option)})}
function fillRankingSegments(){const sector=document.getElementById('ranking-setor')?.value||'',select=document.getElementById('ranking-segmento');if(!select)return;const current=select.value,all=document.createElement('option');all.value='';all.textContent='Todos os segmentos';select.replaceChildren(all);if(!sector)return;const unique=[...new Set((rankingRows||[]).filter(r=>r.setor===sector&&r.segmento).map(r=>r.segmento))].sort((a,b)=>a.localeCompare(b,'pt-BR'));unique.forEach(name=>{const option=document.createElement('option');option.value=name;option.textContent=name;select.append(option)});if([...select.options].some(option=>option.value===current))select.value=current}
async function loadRanking(){const select=document.getElementById('ranking-select'),button=document.getElementById('ranking-load'),setorSelect=document.getElementById('ranking-setor'),segmentSelect=document.getElementById('ranking-segmento');button.disabled=true;try{const response=await fetch('/api/rankings');const data=await response.json();if(!response.ok)throw new Error(data.error||'Falha no servidor local.');
rankingRows=data.rows||[];fillRankingSectors(rankingRows);fillRankingSegments();
const sector=setorSelect?setorSelect.value:'',segment=segmentSelect?segmentSelect.value:'';let rows=rankingRows;if(sector)rows=rows.filter(r=>r.setor===sector);if(segment)rows=rows.filter(r=>r.segmento===segment);
const body=document.getElementById('ranking-body'),empty=document.getElementById('ranking-empty'),note=document.getElementById('ranking-note'),about=document.getElementById('ranking-about'),head=document.getElementById('ranking-head');const def=computeRanking(select.value,rows),picked=def.rows().slice(0,50);
if(head){const columns=['Ativo',...def.cols.map(col=>col[0]),'Cotação'];head.replaceChildren(...columns.map(label=>{const th=document.createElement('th');th.textContent=label;if(INDICATOR_HELP[label])th.title=INDICATOR_HELP[label];return th}))}
if(about)about.textContent=def.about||'';
body.replaceChildren();empty.hidden=!!picked.length;empty.textContent=picked.length?'':'Nenhum ativo corresponde ao filtro nesta lista. Troque o setor, o segmento ou a lista.';
picked.forEach(r=>{const tr=document.createElement('tr'),first=document.createElement('td'),cell=document.createElement('div');cell.className='asset-name';const strong=document.createElement('strong');strong.textContent=r.ticker;const small=document.createElement('small');small.textContent=r.name||r.setor||'';cell.append(strong,small);first.append(cell);tr.append(first);def.cols.forEach(col=>{const c=document.createElement('td');c.textContent=col[1](r);tr.append(c)});const q=document.createElement('td');q.textContent=money(r.quote);tr.append(q);body.append(tr)});
note.textContent=(def.note||'')+(sector?' · '+sector+(segment?' › '+segment:''):'')+' · Fonte: '+data.source+' às '+new Date(data.updatedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+'.'
}catch(error){notify(error.message||'Não carregou a lista. ')}finally{button.disabled=false}}
document.getElementById('ranking-load')?.addEventListener('click',loadRanking);
fireRankingListeners();
function fireRankingListeners(){const setor=document.getElementById('ranking-setor'),segment=document.getElementById('ranking-segmento');if(setor)setor.addEventListener('change',()=>{fillRankingSegments();loadRanking()});if(segment)segment.addEventListener('change',loadRanking)}

['calc-initial', 'calc-monthly', 'calc-rate', 'calc-years', 'dividend-target', 'dividend-yield', 'reserve-expenses', 'reserve-months'].forEach(id => document.getElementById(id).addEventListener('input', renderCalculators));

export {renderCalculators,loadRanking};
