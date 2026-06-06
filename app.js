"use strict";
/* =========================================================================
   FX PULSE — dashboard logic
   ---------------------------------------------------------------------------
   Sections:
     1. Config & state
     2. API layer (fetch with CDN fallback + caching)
     3. Math/analysis helpers (MA, volatility, slope, patterns)
     4. Rendering (current value, table, heatmap, charts, AI, patterns)
     5. Calculator
     6. Theme + events + init
   ========================================================================= */

/* -------------------- 1. CONFIG & STATE -------------------- */
const MAJORS = ["usd","eur","gbp","jpy","aud","cad","chf","cny","sgd","php"];
const FALLBACK_NAMES = {usd:"US Dollar",eur:"Euro",gbp:"British Pound",jpy:"Japanese Yen",
  aud:"Australian Dollar",cad:"Canadian Dollar",chf:"Swiss Franc",cny:"Chinese Yuan",
  sgd:"Singapore Dollar",php:"Philippine Peso",hkd:"Hong Kong Dollar",nzd:"New Zealand Dollar",
  inr:"Indian Rupee",krw:"South Korean Won",thb:"Thai Baht",myr:"Malaysian Ringgit"};

const state = {
  base:"usd",
  target:"php",
  range:30,
  names:{},          // code -> name
  latest:null,       // latest base file: {date, base:{...}}
  yesterday:null,    // most recent prior day base file
  series:[],         // [{date, rate}] for selected target over range
  candles:[],        // [{x,o,h,l,c}]
  table:[],          // computed table rows
  sort:{key:"code",dir:1},
  cache:new Map(),   // url -> json
};

/* -------------------- 2. API LAYER -------------------- */
// Build the candidate URLs (primary jsDelivr, then pages.dev fallback).
function urlsLatest(base){
  return [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${base}.json`
  ];
}
function urlsDated(base,date){
  return [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${base}.json`,
    `https://${date}.currency-api.pages.dev/v1/currencies/${base}.json`
  ];
}
function urlsNames(){
  return [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies.json`,
    `https://latest.currency-api.pages.dev/v1/currencies.json`
  ];
}

// Try each URL in order (with a hard timeout so a stalled request can't hang
// the dashboard); first success wins. Throws if all fail.
async function fetchJson(urls,timeoutMs=10000){
  const key = urls[0];
  if(state.cache.has(key)) return state.cache.get(key);
  let lastErr;
  for(const u of urls){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
    try{
      const res = await fetch(u,{signal:ctrl.signal});
      clearTimeout(timer);
      if(!res.ok) throw new Error("HTTP "+res.status);
      const json = await res.json();
      state.cache.set(key,json);
      return json;
    }catch(e){ clearTimeout(timer); lastErr = e; }
  }
  throw lastErr || new Error("All endpoints failed");
}

// Run async tasks with a concurrency cap (avoids jsDelivr burst throttling
// when fetching many date-tagged files for the historical series).
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);
  let idx=0;
  async function worker(){ while(idx<items.length){ const i=idx++; out[i]=await fn(items[i],i); } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

// All historical dates are derived from the *latest data date* (not the wall
// clock) so the API and the dashboard stay in sync.
function latestDate(){ return state.latest?.date ? new Date(state.latest.date+"T00:00:00Z") : new Date(); }
function ymdMinus(baseDate,n){ const d=new Date(baseDate); d.setUTCDate(d.getUTCDate()-n); return d.toISOString().slice(0,10); }

// Latest rates for a base currency.
async function getLatest(base){ return fetchJson(urlsLatest(base)); }

// Rates for a specific date; returns null if unavailable (no throw).
async function getDated(base,date){
  try{ return await fetchJson(urlsDated(base,date)); }
  catch{ return null; }
}

// Find the most recent available historical file before the latest date,
// scanning back up to `maxBack` days.
async function getRecentPast(base,startOff,maxBack){
  const ld=latestDate();
  for(let i=startOff;i<startOff+maxBack;i++){
    const data = await getDated(base, ymdMinus(ld,i));
    if(data && data[base]) return data;
  }
  return null;
}

/* -------------------- 3. ANALYSIS HELPERS -------------------- */
const mean = a => a.reduce((s,x)=>s+x,0)/(a.length||1);
function stdev(a){ const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); }

// Simple moving average series (window w) aligned to input length (null padded).
function sma(arr,w){
  return arr.map((_,i)=> i<w-1 ? null : mean(arr.slice(i-w+1,i+1)));
}
// Daily % returns.
function returns(arr){ const r=[]; for(let i=1;i<arr.length;i++) r.push((arr[i]-arr[i-1])/arr[i-1]); return r; }
// Normalised linear-regression slope (% per step) for trend strength.
function slopePct(arr){
  const n=arr.length; if(n<2) return 0;
  const xs=arr.map((_,i)=>i), mx=mean(xs), my=mean(arr);
  let num=0,den=0;
  for(let i=0;i<n;i++){ num+=(xs[i]-mx)*(arr[i]-my); den+=(xs[i]-mx)**2; }
  const slope = den? num/den : 0;
  return (slope/my)*100; // % of mean per step
}

// Build estimated daily candles from a close series.
function buildCandles(series){
  if(series.length<2) return [];
  const closes = series.map(p=>p.rate);
  const rets = returns(closes);
  const vol = stdev(rets); // typical daily move (fraction)
  const out=[];
  for(let i=1;i<series.length;i++){
    const open=closes[i-1], close=closes[i];
    const body=Math.abs(close-open);
    // wick estimate: at least the body, padded by recent volatility
    const wick = Math.max(body*0.6, close*vol*0.9);
    const hi = Math.max(open,close)+wick;
    const lo = Math.min(open,close)-wick;
    out.push({ x: luxon.DateTime.fromISO(series[i].date).toMillis(), o:open, h:hi, l:lo, c:close });
  }
  return out;
}

// Detect market patterns from a close series. Returns [{tag,cls,text}].
function detectPatterns(series){
  const closes = series.map(p=>p.rate);
  if(closes.length<5) return [{tag:"info",cls:"t-flat",text:"Not enough history to analyse patterns."}];
  const out=[];
  const rets=returns(closes);
  const vol=stdev(rets)*100;
  const slope=slopePct(closes);
  const last=closes[closes.length-1];
  const sShort=sma(closes,5), sLong=sma(closes,Math.min(10,closes.length-1));
  const maShort=sShort[sShort.length-1], maLong=sLong[sLong.length-1];

  // Trend (via regression slope)
  if(slope>0.12) out.push({tag:"Uptrend",cls:"t-up",text:`Rate is rising ~${slope.toFixed(2)}% per day on a regression fit.`});
  else if(slope<-0.12) out.push({tag:"Downtrend",cls:"t-down",text:`Rate is falling ~${Math.abs(slope).toFixed(2)}% per day on a regression fit.`});
  else out.push({tag:"Sideways",cls:"t-flat",text:"No clear direction — rate is moving sideways."});

  // Breakout: last value beyond recent range (exclude last point)
  const prior=closes.slice(0,-1);
  const hiP=Math.max(...prior), loP=Math.min(...prior);
  if(last>hiP) out.push({tag:"Breakout ↑",cls:"t-break",text:"Closed above its recent high — upside breakout."});
  else if(last<loP) out.push({tag:"Breakout ↓",cls:"t-break",text:"Closed below its recent low — downside breakout."});

  // Volatility spike: recent vol vs earlier vol
  if(rets.length>=8){
    const half=Math.floor(rets.length/2);
    const recent=stdev(rets.slice(half))*100, early=stdev(rets.slice(0,half))*100;
    if(recent>early*1.6 && recent>0.25)
      out.push({tag:"Volatility spike",cls:"t-vol",text:`Recent swings (${recent.toFixed(2)}%) are well above the earlier ${early.toFixed(2)}% baseline.`});
  }

  // MA crossover (golden/death) in the last step
  if(maShort!=null && maLong!=null){
    const pShort=sShort[sShort.length-2], pLong=sLong[sLong.length-2];
    if(pShort!=null && pLong!=null){
      if(pShort<=pLong && maShort>maLong) out.push({tag:"Bullish crossover",cls:"t-up",text:"Short MA crossed above long MA — bullish signal."});
      else if(pShort>=pLong && maShort<maLong) out.push({tag:"Bearish crossover",cls:"t-down",text:"Short MA crossed below long MA — bearish signal."});
    }
  }
  return out;
}

// Generate human-readable rule-based AI insights.
function buildInsights(series,base,target){
  const pair=`${base.toUpperCase()}/${target.toUpperCase()}`;
  const closes=series.map(p=>p.rate);
  const out=[];
  if(closes.length<3){ return [{ic:"ℹ️",t:"Limited history available for "+pair+".",s:""}]; }
  const slope=slopePct(closes);
  const totalChg=((closes[closes.length-1]-closes[0])/closes[0])*100;
  const vol=stdev(returns(closes))*100;
  const ma7=sma(closes,Math.min(7,closes.length))[closes.length-1];
  const last=closes[closes.length-1];

  // 1. Directional pressure
  if(slope>0.12) out.push({ic:"📈",t:`${pair} is showing upward pressure, up ${totalChg.toFixed(2)}% over the last ${closes.length} days.`,s:"Buyers currently in control."});
  else if(slope<-0.12) out.push({ic:"📉",t:`${pair} is under downward pressure, down ${Math.abs(totalChg).toFixed(2)}% over the last ${closes.length} days.`,s:"Sellers currently in control."});
  else out.push({ic:"➡️",t:`${pair} is broadly flat (${totalChg>=0?"+":""}${totalChg.toFixed(2)}%) — a consolidation phase.`,s:"Direction unclear; range-bound."});

  // 2. MA momentum
  if(ma7!=null){
    if(last>ma7*1.001) out.push({ic:"🟢",t:`Price is above its ${Math.min(7,closes.length)}-day moving average, suggesting bullish momentum.`,s:`Last ${last.toFixed(4)} vs MA ${ma7.toFixed(4)}.`});
    else if(last<ma7*0.999) out.push({ic:"🔵",t:`Price is below its ${Math.min(7,closes.length)}-day moving average, suggesting bearish momentum.`,s:`Last ${last.toFixed(4)} vs MA ${ma7.toFixed(4)}.`});
  }

  // 3. Volatility read
  if(vol>0.6) out.push({ic:"⚡",t:"Volatility is higher than usual, so short-term movement may be unstable.",s:`Avg daily swing ≈ ${vol.toFixed(2)}%.`});
  else out.push({ic:"🛡️",t:"Volatility is subdued — movements are relatively calm and orderly.",s:`Avg daily swing ≈ ${vol.toFixed(2)}%.`});

  return out;
}

/* -------------------- 4. RENDERING -------------------- */
const $ = id => document.getElementById(id);
const fmt = (v,d=4)=> v==null||isNaN(v) ? "—" : Number(v).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:Math.min(2,d)});
const nameOf = c => state.names[c] || FALLBACK_NAMES[c] || c.toUpperCase();

function trendClass(p){ return p>0.05?"up":p<-0.05?"down":"flat"; }
function trendWord(p){ return p>0.05?"Uptrend":p<-0.05?"Downtrend":"Stable"; }

// --- Current value card ---
function renderCurrent(){
  const {base,target,latest,yesterday,series}=state;
  const rate = latest?.[base]?.[target];
  $("pairLabel").textContent = `${base.toUpperCase()}/${target.toUpperCase()}`;
  $("rateBig").textContent = fmt(rate,4);

  // daily change vs most recent prior day
  let chg=null;
  const prev = yesterday?.[base]?.[target];
  if(prev) chg = ((rate-prev)/prev)*100;
  const cv=$("changeVal");
  if(chg==null){ cv.textContent="n/a"; cv.className="change flat"; }
  else{ cv.textContent=`${chg>=0?"▲ +":"▼ "}${chg.toFixed(3)}%`; cv.className="change "+trendClass(chg); }

  const badge=$("trendBadge");
  badge.textContent=trendWord(chg??0);
  badge.className="badge "+trendClass(chg??0);

  // 7d stats from series
  const closes=series.map(p=>p.rate);
  if(closes.length){
    $("m7high").textContent=fmt(Math.max(...closes),4);
    $("m7low").textContent=fmt(Math.min(...closes),4);
    $("mvol").textContent=(stdev(returns(closes))*100).toFixed(2)+"%";
  }
}

// --- Table ---
function computeTable(){
  const {base,latest,yesterday}=state;
  const cur=latest?.[base]||{};
  const prev=yesterday?.[base]||{};
  const rows=[];
  for(const code in cur){
    if(code===base) continue;
    const rate=cur[code];
    const p=prev[code];
    const change = (p!=null && p!==0) ? ((rate-p)/p)*100 : null;
    rows.push({code,name:nameOf(code),rate,change});
  }
  // mark strongest / weakest by change among comparable rows
  const withChg=rows.filter(r=>r.change!=null);
  if(withChg.length){
    let s=withChg[0], w=withChg[0];
    for(const r of withChg){ if(r.change>s.change)s=r; if(r.change<w.change)w=r; }
    s.lead="s"; w.lead="w";
  }
  state.table=rows;
}
function renderTable(){
  const q=$("tableSearch").value.trim().toLowerCase();
  const {key,dir}=state.sort;
  let rows=state.table.slice();
  if(q) rows=rows.filter(r=>r.code.includes(q)||r.name.toLowerCase().includes(q));
  rows.sort((a,b)=>{
    let av=a[key], bv=b[key];
    if(key==="change"){ av=av??-Infinity; bv=bv??-Infinity; }
    if(typeof av==="string") return av.localeCompare(bv)*dir;
    return (av-bv)*dir;
  });
  const body=$("rateBody");
  body.innerHTML = rows.map(r=>{
    const cls = trendClass(r.change??0);
    const sign = r.change==null?"":(r.change>=0?"+":"");
    const lead = r.lead==="s"?`<span class="lead s">Strong</span>`:r.lead==="w"?`<span class="lead w">Weak</span>`:"";
    const rowCls = r.lead==="s"?"row-strong":r.lead==="w"?"row-weak":"";
    const arrow = r.change==null?"·":r.change>0.05?"▲":r.change<-0.05?"▼":"—";
    return `<tr class="${rowCls}">
      <td class="code">${r.code.toUpperCase()}${lead}</td>
      <td class="name">${r.name}</td>
      <td class="num">${fmt(r.rate,r.rate<10?5:2)}</td>
      <td class="num"><span class="pill ${cls}">${r.change==null?"n/a":sign+r.change.toFixed(2)+"%"}</span></td>
      <td>${arrow} ${trendWord(r.change??0)}</td>
    </tr>`;
  }).join("");
  $("tableCount").textContent=`${rows.length} currencies`;
  $("tableBaseLbl").textContent=`(1 ${state.base.toUpperCase()} = …)`;
  // header arrows
  document.querySelectorAll("thead th[data-sort]").forEach(th=>{
    const a=th.querySelector(".arr");
    if(!a) return;
    a.textContent = th.dataset.sort===key ? (dir>0?"▲":"▼") : "";
  });
}

// --- AI + patterns ---
function renderAI(){
  const ins=buildInsights(state.series,state.base,state.target);
  $("aiList").innerHTML = ins.map(i=>`<div class="insight"><div class="ic">${i.ic}</div><p>${i.t}<span>${i.s||""}</span></p></div>`).join("");
}
function renderPatterns(){
  const ps=detectPatterns(state.series);
  $("patternList").innerHTML = ps.map(p=>`<div class="pattern"><span class="tag ${p.cls}">${p.tag}</span><small>${p.text}</small></div>`).join("");
}

// --- Heatmap (basket-weighted 7-day strength from USD cross rates) ---
async function renderHeatmap(){
  const grid=$("heatGrid");
  grid.innerHTML = MAJORS.map(()=>`<div class="heat-cell skeleton" style="height:78px"></div>`).join("");
  // Cross rate C->O derived from USD file: rate = usd[O]/usd[C]
  const now = await getLatest("usd");
  const past = await getRecentPast("usd",7,7);
  if(!now?.usd || !past?.usd){ grid.innerHTML=`<div style="color:var(--text-faint);font-size:.8rem">Heatmap data unavailable.</div>`; return; }
  const N=now.usd, P=past.usd;
  const valNow=c=> c==="usd"?1:N[c], valPast=c=> c==="usd"?1:P[c];
  const strength={};
  for(const c of MAJORS){
    const diffs=[];
    for(const o of MAJORS){
      if(o===c) continue;
      const rNow=valNow(o)/valNow(c), rPast=valPast(o)/valPast(c);
      if(rPast) diffs.push(((rNow-rPast)/rPast)*100);
    }
    strength[c]=mean(diffs);
  }
  const vals=Object.values(strength);
  const lo=Math.min(...vals), hi=Math.max(...vals), span=(hi-lo)||1;
  // cool color ramp: muted navy (weak) -> bright mint/cyan (strong). No purple.
  const ramp=t=>{
    const stops=[[11,34,51],[14,74,90],[19,138,138],[31,182,166],[127,240,200]];
    const x=t*(stops.length-1), i=Math.min(stops.length-2,Math.floor(x)), f=x-i;
    const c=stops[i].map((v,k)=>Math.round(v+(stops[i+1][k]-v)*f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const ordered=[...MAJORS].sort((a,b)=>strength[b]-strength[a]);
  grid.innerHTML = ordered.map((c,idx)=>{
    const t=(strength[c]-lo)/span;
    const tag = idx===0?"Strongest":idx===ordered.length-1?"Weakest":(strength[c]>=0?"Firm":"Soft");
    return `<div class="heat-cell" style="background:${ramp(t)};${t<0.4?'color:#cfe8f2':''}">
      <div class="code">${c.toUpperCase()}</div>
      <div class="pct">${strength[c]>=0?"+":""}${strength[c].toFixed(2)}%</div>
      <div class="lbl">${tag}</div></div>`;
  }).join("");
}

/* -------------------- CHARTS -------------------- */
let candleChart, lineChart;
function themeColors(){
  const cs=getComputedStyle(document.documentElement);
  return {
    text:cs.getPropertyValue("--text-dim").trim(),
    grid:cs.getPropertyValue("--grid").trim(),
    up:cs.getPropertyValue("--c-up").trim(),
    down:cs.getPropertyValue("--c-down").trim(),
    accent:cs.getPropertyValue("--accent").trim(),
    accent2:cs.getPropertyValue("--accent-2").trim(),
    slate:cs.getPropertyValue("--c-slate").trim(),
  };
}
function renderCandles(){
  const tc=themeColors();
  state.candles=buildCandles(state.series);
  const ctx=$("candleChart");
  if(candleChart) candleChart.destroy();
  candleChart=new Chart(ctx,{
    type:"candlestick",
    data:{datasets:[{
      label:`${state.base.toUpperCase()}/${state.target.toUpperCase()} (est.)`,
      data:state.candles,
      // chartjs-chart-financial uses the *plural* keys; keeps candles on the
      // cool palette (teal = up, slate-blue = down) — no warm reds.
      backgroundColors:{up:tc.up,down:tc.down,unchanged:tc.slate},
      borderColors:{up:tc.up,down:tc.down,unchanged:tc.slate},
    }]},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{
        label:c=>{const o=c.raw;return [`O ${fmt(o.o,4)}`,`H ${fmt(o.h,4)}`,`L ${fmt(o.l,4)}`,`C ${fmt(o.c,4)}`];}
      }}},
      scales:{
        x:{type:"time",time:{unit:state.range>30?"week":"day"},grid:{color:tc.grid},ticks:{color:tc.text,maxRotation:0,autoSkip:true,maxTicksLimit:8}},
        y:{grid:{color:tc.grid},ticks:{color:tc.text}}
      }
    }
  });
}
function renderLine(){
  const tc=themeColors();
  const labels=state.series.map(p=>p.date);
  const data=state.series.map(p=>p.rate);
  const ma=sma(data,7);
  const ctx=$("lineChart");
  if(lineChart) lineChart.destroy();
  // gradient fill under the line
  const g=ctx.getContext("2d").createLinearGradient(0,0,0,320);
  g.addColorStop(0,"rgba(34,211,238,.30)"); g.addColorStop(1,"rgba(34,211,238,0)");
  lineChart=new Chart(ctx,{
    type:"line",
    data:{labels,datasets:[
      {label:"Rate",data,borderColor:tc.accent,backgroundColor:g,fill:true,tension:.3,pointRadius:0,borderWidth:2.4},
      {label:"7-day MA",data:ma,borderColor:tc.accent2,borderDash:[6,5],fill:false,tension:.3,pointRadius:0,borderWidth:1.8}
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:"index",intersect:false},
      plugins:{legend:{display:true,labels:{color:tc.text,boxWidth:14,usePointStyle:true}},
        tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${fmt(c.parsed.y,5)}`}}},
      scales:{
        x:{grid:{color:tc.grid},ticks:{color:tc.text,maxRotation:0,autoSkip:true,maxTicksLimit:8}},
        y:{grid:{color:tc.grid},ticks:{color:tc.text}}
      }
    }
  });
}

/* -------------------- 5. CALCULATOR -------------------- */
async function runCalc(){
  const amt=parseFloat($("calcAmount").value)||0;
  const from=$("calcFrom").value, to=$("calcTo").value;
  try{
    const data=await getLatest(from);
    const rate = from===to ? 1 : data?.[from]?.[to];
    if(rate==null){ $("calcOut").textContent="—"; $("calcRate").textContent="rate unavailable"; return; }
    const res=amt*rate;
    $("calcOut").textContent=`${fmt(res, res<10?4:2)} ${to.toUpperCase()}`;
    $("calcRate").textContent=`1 ${from.toUpperCase()} = ${fmt(rate,6)} ${to.toUpperCase()}`;
  }catch{ $("calcRate").textContent="rate unavailable"; }
}

/* -------------------- DATA FETCH ORCHESTRATION -------------------- */
// Fetch the rate series for the selected target across the chosen range.
// Dates are counted back from the latest data date; requests are throttled.
async function fetchSeries(){
  const {base,target,range}=state;
  const ld=latestDate();
  const step = range>60 ? 3 : 1;               // sample longer ranges to limit requests
  const offsets=[]; for(let off=0;off<=range;off+=step) offsets.push(off);
  const results = await mapLimit(offsets,6, async off=>{
    if(off===0){ const d=state.latest||await getLatest(base); return d?{date:d.date,rate:d[base]?.[target]}:null; }
    const d=await getDated(base, ymdMinus(ld,off));
    return d && d[base]?.[target]!=null ? {date:d.date,rate:d[base][target]} : null;
  });
  // dedupe by date + sort ascending
  const map=new Map();
  results.filter(Boolean).forEach(p=>{ if(p.rate!=null) map.set(p.date,p.rate); });
  state.series=[...map.entries()].map(([date,rate])=>({date,rate})).sort((a,b)=>a.date<b.date?-1:1);
}

// Refresh only the series-dependent widgets (line, candles, AI, patterns, value stats).
async function refreshSeries(){
  await fetchSeries();
  renderLine(); renderCandles(); renderAI(); renderPatterns(); renderCurrent();
}

// Full refresh. Core widgets (value, table, calculator) render first from the
// two base files; charts + heatmap then load progressively in the background.
async function refreshAll(){
  showLoading(true,"Fetching exchange data…");
  $("refreshBtn").classList.add("spin");
  try{
    state.cache.clear();
    state.latest = await getLatest(state.base);
    state.yesterday = await getRecentPast(state.base,1,7);
    computeTable(); renderTable();
    renderCurrent();          // show rate + daily change immediately
    stampUpdated();
    await runCalc();
    showLoading(false);       // core dashboard is now usable
    // Progressive load — failures here never block the core dashboard.
    await Promise.allSettled([ refreshSeries(), renderHeatmap() ]);
  }catch(e){
    showError("Could not load exchange data ("+(e.message||"unknown")+"). Primary & fallback endpoints unreachable.");
  }finally{
    showLoading(false);
    $("refreshBtn").classList.remove("spin");
  }
}

/* -------------------- 6. THEME / EVENTS / INIT -------------------- */
function stampUpdated(){
  const t=new Date();
  $("updatedAt").textContent=t.toLocaleString(undefined,{hour:"2-digit",minute:"2-digit",second:"2-digit",day:"2-digit",month:"short"});
  const dataDate = state.latest?.date ? ` · data date ${state.latest.date}` : "";
  $("srcLabel").textContent=dataDate;
}
function showLoading(on,msg){ if(msg)$("loadMsg").textContent=msg; $("overlay").classList.toggle("show",on); }
function showError(msg){ $("toastMsg").textContent=msg; const t=$("toast"); t.classList.add("show"); clearTimeout(showError._t); showError._t=setTimeout(()=>t.classList.remove("show"),7000); }

function applyTheme(theme){
  document.documentElement.setAttribute("data-theme",theme);
  $("themeIcon").textContent = theme==="dark"?"🌙":"☀️";
  localStorage.setItem("fxpulse-theme",theme);
  // re-render charts so they pick up theme colors
  if(state.series.length){ renderLine(); renderCandles(); }
}

function fillSelect(sel,selected){
  const codes=Object.keys(state.names).sort();
  sel.innerHTML=codes.map(c=>`<option value="${c}" ${c===selected?"selected":""}>${c.toUpperCase()} — ${nameOf(c)}</option>`).join("");
}

function bindEvents(){
  $("baseSel").addEventListener("change",e=>{ state.base=e.target.value; refreshAll(); });
  $("targetSel").addEventListener("change",e=>{ state.target=e.target.value; refreshSeries(); });
  $("refreshBtn").addEventListener("click",refreshAll);
  $("themeBtn").addEventListener("click",()=>{
    applyTheme(document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark");
  });
  // range buttons
  $("rangeBtns").addEventListener("click",e=>{
    const b=e.target.closest("button"); if(!b) return;
    state.range=+b.dataset.d;
    document.querySelectorAll("#rangeBtns button").forEach(x=>x.classList.toggle("active",x===b));
    showLoading(true,"Loading "+state.range+"-day history…");
    refreshSeries().finally(()=>showLoading(false));
  });
  // table search + sort
  $("tableSearch").addEventListener("input",renderTable);
  document.querySelectorAll("thead th[data-sort]").forEach(th=>{
    th.addEventListener("click",()=>{
      const k=th.dataset.sort;
      if(state.sort.key===k) state.sort.dir*=-1; else state.sort={key:k,dir:k==="code"||k==="name"?1:-1};
      renderTable();
    });
  });
  // calculator
  ["input","change"].forEach(ev=>{
    $("calcAmount").addEventListener(ev,runCalc);
    $("calcFrom").addEventListener("change",runCalc);
    $("calcTo").addEventListener("change",runCalc);
  });
  $("calcSwap").addEventListener("click",()=>{
    const f=$("calcFrom").value; $("calcFrom").value=$("calcTo").value; $("calcTo").value=f; runCalc();
  });
}

async function init(){
  // theme first (no flash)
  applyTheme(localStorage.getItem("fxpulse-theme")||"dark");
  // currency names for selectors
  try{ state.names=await fetchJson(urlsNames()); }
  catch{ state.names={...FALLBACK_NAMES}; showError("Currency list endpoint failed — using a reduced fallback list."); }
  fillSelect($("baseSel"),state.base);
  fillSelect($("targetSel"),state.target);
  fillSelect($("calcFrom"),"usd");
  fillSelect($("calcTo"),"eur");
  bindEvents();
  await refreshAll();
}

// Wait for Chart.js (and financial plugin) then boot.
window.addEventListener("DOMContentLoaded",init);
