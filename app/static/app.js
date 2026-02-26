const TZ = 'Asia/Baghdad';
const REFRESH = 5000;
const CHART_REFRESH = 60000;

const THRESHOLDS = {
    co2:   [{max:800,level:'good',label:'Good'},{max:1200,level:'moderate',label:'Moderate'},{max:Infinity,level:'poor',label:'High'}],
    pm25:  [{max:35,level:'good',label:'Good'},{max:75,level:'moderate',label:'Moderate'},{max:Infinity,level:'poor',label:'Unhealthy'}],
    pm10:  [{max:50,level:'good',label:'Good'},{max:150,level:'moderate',label:'Moderate'},{max:Infinity,level:'poor',label:'Unhealthy'}],
    tvoc:  [{max:100,level:'good',label:'Low'},{max:250,level:'moderate',label:'Moderate'},{max:Infinity,level:'poor',label:'High'}],
    noise: [{max:40,level:'good',label:'Quiet'},{max:65,level:'moderate',label:'Normal'},{max:Infinity,level:'poor',label:'Loud'}],
    uv:    [{max:2,level:'good',label:'Low Risk'},{max:5,level:'moderate',label:'Moderate'},{max:7,level:'poor',label:'High'},{max:10,level:'severe',label:'Very High'},{max:Infinity,level:'extreme',label:'Extreme'}],
};
const DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

let currentRange = '24h';
let charts = {};
let chartsInit = false;
let lastWeatherTs = null, lastAirTs = null;
let prev = {};
let pressureHist = [];

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    fetchCurrent();
    fetchHistory();
    setInterval(fetchCurrent, REFRESH);
    setInterval(fetchHistory, CHART_REFRESH);
    setInterval(tickClock, 1000);
});

// ── Tabs ──
function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => {
        document.querySelector('.tab-btn.active').classList.remove('active');
        b.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById('tab-' + b.dataset.tab).classList.add('active');
        if (b.dataset.tab === 'charts' && !chartsInit) { initCharts(); chartsInit = true; fetchHistory(); }
    }));
    document.querySelectorAll('.range-selector button').forEach(b => b.addEventListener('click', () => {
        document.querySelector('.range-selector .active').classList.remove('active');
        b.classList.add('active');
        currentRange = b.dataset.range;
        fetchHistory();
    }));
}

// ── Clock ──
function tickClock() {
    const el = document.getElementById('live-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    refreshAgo('weather-dot','weather-ago', lastWeatherTs);
    refreshAgo('air-dot','air-ago', lastAirTs);
}
function refreshAgo(dotId, textId, ts) {
    const dot = document.getElementById(dotId), text = document.getElementById(textId);
    if (!dot||!text) return;
    if (!ts) { dot.className='status-dot offline'; text.textContent='offline'; return; }
    const s = Math.floor((Date.now()-new Date(ts).getTime())/1000);
    dot.className = 'status-dot '+(s<900?'online':s<3600?'stale':'offline');
    text.textContent = s<60? s+'s ago' : s<3600? Math.floor(s/60)+'m ago' : Math.floor(s/3600)+'h ago';
}

// ── Data ──
async function fetchCurrent() {
    try {
        const r = await fetch('/api/current');
        const d = await r.json();
        updateWeather(d.weather);
        updateAir(d.air);
        if (d.weather?.ts) lastWeatherTs = d.weather.ts;
        if (d.air?.ts) lastAirTs = d.air.ts;
    } catch(e) { console.error(e); }
}
async function fetchHistory() {
    try {
        const [wr,ar] = await Promise.all([
            fetch('/api/history?source=weather&range='+currentRange),
            fetch('/api/history?source=air&range='+currentRange),
        ]);
        const w = await wr.json(), a = await ar.json();
        const wd = w.data||[], ad = a.data||[];
        // pressure trend
        pressureHist = wd.filter(r=>r.pressure_rel_hpa!=null).map(r=>({ts:new Date(r.ts).getTime(),v:r.pressure_rel_hpa}));
        updatePressureTrend();
        if (chartsInit) updateCharts(wd, ad);
    } catch(e) { console.error(e); }
}

// ── Helpers ──
function fmt(v,d) { return v==null?'--':Number(v).toFixed(d); }
function setT(id,v) { const e=document.getElementById(id); if(e) e.textContent=v??'--'; }
function setV(id,v) {
    const el=document.getElementById(id); if(!el) return;
    const d=v??'--';
    if(prev[id]!==undefined && prev[id]!==String(d)) {
        el.textContent=d;
        const c=el.closest('.card');
        if(c&&!c.hasAttribute('data-level')){c.classList.add('flash');setTimeout(()=>c.classList.remove('flash'),800);}
    } else { el.textContent=d; }
    prev[id]=String(d);
}
function getStatus(metric,v) {
    if(v==null) return {level:null,label:'--'};
    for(const t of (THRESHOLDS[metric]||[])) if(v<=t.max) return t;
    return {level:null,label:'--'};
}
function applyStatus(cardId, statusId, metric, v) {
    const card=document.getElementById(cardId), st=document.getElementById(statusId);
    const s=getStatus(metric,v);
    if(card){ if(s.level) card.dataset.level=s.level; else card.removeAttribute('data-level'); }
    if(st){ st.textContent=s.label; if(s.level) st.dataset.level=s.level; else st.removeAttribute('data-level'); }
}
function degDir(d) { return d==null?'--':DIRS[Math.round(d/22.5)%16]; }

// ── Weather ──
function updateWeather(w) {
    if(!w) return;
    setV('val-temp', fmt(w.temp_c,1));
    setT('val-feels', fmt(w.feels_like_c,1)+'°C');
    setT('val-dewpoint', fmt(w.dew_point_c,1)+'°C');
    setV('val-humidity', fmt(w.humidity,0));

    // Wind
    updateWindCard(w);

    // Pressure
    setV('val-pressure', fmt(w.pressure_rel_hpa,1));

    // Rain
    setT('val-rain-hourly', fmt(w.rain_hourly_mm,1));
    setT('val-rain', fmt(w.rain_daily_mm,1));
    setT('val-rain-month', fmt(w.rain_monthly_mm,1));

    // UV
    setV('val-uv', w.uv_index??'--');
    const uvS = getStatus('uv', w.uv_index);
    const uvEl = document.getElementById('uv-risk');
    if(uvEl){ uvEl.textContent=uvS.label; if(uvS.level) uvEl.dataset.level=uvS.level; else uvEl.removeAttribute('data-level'); }

    // Solar
    setV('val-solar', fmt(w.solar_radiation,0));

    // Indoor
    setT('val-itemp', fmt(w.temp_indoor_c,1)+'°C');
    setT('val-ihumidity', fmt(w.humidity_indoor,0)+'%');
    setT('val-ifeels', fmt(w.feels_like_indoor_c,1)+'°C');
    setT('val-idewpoint', fmt(w.dew_point_indoor_c,1)+'°C');

    // Abdu
    setT('val-ch8temp', fmt(w.temp_ch8_c,1)+'°C');
    setT('val-ch8humidity', fmt(w.humidity_ch8,0)+'%');
    setT('val-ch8feels', fmt(w.feels_like_ch8_c,1)+'°C');
    setT('val-ch8dewpoint', fmt(w.dew_point_ch8_c,1)+'°C');
}

// ── Air ──
function updateAir(a) {
    if(!a) return;
    setV('val-co2', a.co2??'--');
    setV('val-pm25', a.pm25??'--');
    setV('val-pm10', a.pm10??'--');
    setV('val-tvoc', a.tvoc??'--');
    setV('val-noise', a.noise??'--');
    setT('val-battery', a.battery??'--');
    setT('val-aqtemp', fmt(a.temperature,1)+'°C');
    setT('val-aqhumidity', fmt(a.humidity,1)+'%');

    applyStatus('card-co2','co2-status','co2',a.co2);
    applyStatus('card-pm25','pm25-status','pm25',a.pm25);
    applyStatus('card-pm10','pm10-status','pm10',a.pm10);
    applyStatus('card-tvoc','tvoc-status','tvoc',a.tvoc);
    applyStatus('card-noise','noise-status','noise',a.noise);
}

// ── Wind card (CSS-based circle + arrow, no SVG) ──
function updateWindCard(w) {
    const speed = w.wind_speed_kmh;
    const gust = w.wind_gust_kmh;
    const dir = w.wind_dir;
    setT('wind-speed', speed != null ? speed.toFixed(1) : '--');
    setT('wind-gust', gust != null ? gust.toFixed(1) : '--');
    setT('wind-dir-text', degDir(dir));
    const indicator = document.getElementById('wind-indicator');
    if (indicator && dir != null) indicator.style.transform = `rotate(${dir}deg)`;
}

// ── Pressure trend ──
function updatePressureTrend() {
    const el=document.getElementById('pressure-trend');
    if(!el||pressureHist.length<2) { if(el) el.textContent=''; return; }
    const now=Date.now(), cutoff=now-3*3600000;
    let old=pressureHist.find(p=>p.ts>=cutoff)||pressureHist[0];
    const cur=pressureHist[pressureHist.length-1];
    const diff=cur.v-old.v;
    if(diff>1) { el.className='pressure-trend-line rising'; el.innerHTML='\u2191 '+fmt(Math.abs(diff),1)+' hPa/3h'; }
    else if(diff<-1) { el.className='pressure-trend-line falling'; el.innerHTML='\u2193 '+fmt(Math.abs(diff),1)+' hPa/3h'; }
    else { el.className='pressure-trend-line steady'; el.innerHTML='\u2192 stable'; }
}

// ── Charts ──
function initCharts() {
    const base = {
        responsive:true, maintainAspectRatio:false, animation:{duration:300},
        interaction:{mode:'index',intersect:false},
        scales:{
            x:{type:'time',time:{tooltipFormat:'MMM d, HH:mm'},ticks:{color:'#7a8ba8',maxTicksLimit:8,font:{size:11}},grid:{color:'#1e2f50'}},
            y:{ticks:{color:'#7a8ba8',font:{size:11}},grid:{color:'#1e2f50'}},
        },
        plugins:{
            legend:{labels:{color:'#9ca3af',boxWidth:10,padding:10,font:{size:11}}},
            title:{display:true,color:'#9ca3af',font:{size:12,weight:'500'},padding:{bottom:6}},
        },
        elements:{point:{radius:0,hoverRadius:4},line:{borderWidth:2,tension:0.3}},
    };
    function o(t,u){const c=JSON.parse(JSON.stringify(base));c.plugins.title.text=t;if(u)c.scales.y.title={display:true,text:u,color:'#7a8ba8',font:{size:11}};return c;}

    charts.temp=new Chart(document.getElementById('chart-temp'),{type:'line',data:{datasets:[
        {label:'Outdoor',borderColor:'#ff9800',data:[]},{label:'Indoor',borderColor:'#4a9eff',data:[]},
        {label:'Abdu',borderColor:'#b388ff',data:[]},{label:'Air Mon',borderColor:'#4caf50',data:[]},
    ]},options:o('Temperature','\u00B0C')});

    charts.humidity=new Chart(document.getElementById('chart-humidity'),{type:'line',data:{datasets:[
        {label:'Outdoor',borderColor:'#00d4ff',data:[]},{label:'Indoor',borderColor:'#8b5cf6',data:[]},
        {label:'Abdu',borderColor:'#b388ff',data:[]},{label:'Air Mon',borderColor:'#4caf50',data:[]},
    ]},options:o('Humidity','%')});

    const ao=o('Air Quality');
    ao.scales.y.title={display:true,text:'CO\u2082 ppm',color:'#7a8ba8',font:{size:11}};
    ao.scales.y2={position:'right',title:{display:true,text:'\u00B5g/m\u00B3',color:'#7a8ba8',font:{size:11}},ticks:{color:'#7a8ba8',font:{size:11}},grid:{drawOnChartArea:false}};
    charts.air=new Chart(document.getElementById('chart-air'),{type:'line',data:{datasets:[
        {label:'CO\u2082',borderColor:'#ffc107',data:[],yAxisID:'y'},
        {label:'PM2.5',borderColor:'#ff5252',data:[],yAxisID:'y2'},
        {label:'PM10',borderColor:'#ff9800',data:[],yAxisID:'y2'},
    ]},options:ao});

    charts.wind=new Chart(document.getElementById('chart-wind'),{type:'line',data:{datasets:[
        {label:'Speed',borderColor:'#4caf50',data:[]},{label:'Gust',borderColor:'#4caf5050',borderDash:[4,4],data:[]},
    ]},options:o('Wind','km/h')});

    charts.pressure=new Chart(document.getElementById('chart-pressure'),{type:'line',data:{datasets:[
        {label:'Pressure',borderColor:'#b388ff',data:[]},
    ]},options:o('Barometric Pressure','hPa')});

    charts.rain=new Chart(document.getElementById('chart-rain'),{type:'bar',data:{datasets:[
        {label:'Hourly Rain',backgroundColor:'#4a9eff80',borderColor:'#4a9eff',borderWidth:1,data:[]},
    ]},options:o('Rainfall','mm')});
}
function updateCharts(wd,ad) {
    function xy(d,f){return d.filter(r=>r[f]!=null).map(r=>({x:r.ts,y:r[f]}));}
    charts.temp.data.datasets[0].data=xy(wd,'temp_c');
    charts.temp.data.datasets[1].data=xy(wd,'temp_indoor_c');
    charts.temp.data.datasets[2].data=xy(wd,'temp_ch8_c');
    charts.temp.data.datasets[3].data=xy(ad,'temperature');
    charts.temp.update();
    charts.humidity.data.datasets[0].data=xy(wd,'humidity');
    charts.humidity.data.datasets[1].data=xy(wd,'humidity_indoor');
    charts.humidity.data.datasets[2].data=xy(wd,'humidity_ch8');
    charts.humidity.data.datasets[3].data=xy(ad,'humidity');
    charts.humidity.update();
    charts.air.data.datasets[0].data=xy(ad,'co2');
    charts.air.data.datasets[1].data=xy(ad,'pm25');
    charts.air.data.datasets[2].data=xy(ad,'pm10');
    charts.air.update();
    charts.wind.data.datasets[0].data=xy(wd,'wind_speed_kmh');
    charts.wind.data.datasets[1].data=xy(wd,'wind_gust_kmh');
    charts.wind.update();
    charts.pressure.data.datasets[0].data=xy(wd,'pressure_rel_hpa');
    charts.pressure.update();
    charts.rain.data.datasets[0].data=xy(wd,'rain_hourly_mm');
    charts.rain.update();
}
