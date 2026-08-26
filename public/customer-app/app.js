const API='https://good-shepherd-server-j06f.onrender.com';
const TOKEN_KEY='gs_customer_token';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const val=(o,k,d=null)=>o&&o[k]!==undefined&&o[k]!==null&&o[k]!==''?o[k]:d;
const clean=(v,d='—')=>String(v??'').trim()||d;
const arr=v=>Array.isArray(v)?v:[];
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const token=()=>localStorage.getItem(TOKEN_KEY);
let state={boot:null,ai:null,resident:null,a:null,showAllUpdates:false,systemOpen:false,prompt:'dailySummary',online:true,lastLoaded:null,detail:null};

async function api(path,opts={}){const headers={'Content-Type':'application/json',...(opts.headers||{})};if(token())headers.Authorization=`Bearer ${token()}`;const r=await fetch(API+path,{...opts,headers});let j={};try{j=await r.json()}catch{}if(!r.ok)throw Object.assign(new Error(j.error||'Unable to connect to Good Shepherd.'),{status:r.status});return j}
function fmtDate(v){if(!v)return 'Not available';const d=new Date(v);if(isNaN(d))return clean(v,'Not available');return d.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
function fmtTime(v){if(!v)return null;const d=new Date(v);if(isNaN(d))return clean(v,null);return d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}
function relative(v){if(!v)return 'Not yet available';const d=new Date(v);if(isNaN(d))return clean(v,'Not yet available');const m=Math.max(0,Math.round((Date.now()-d.getTime())/60000));if(m<1)return 'Just now';if(m<60)return `${m} min ago`;const h=Math.floor(m/60);if(h<24)return `${h} hr${h===1?'':'s'} ago`;const days=Math.floor(h/24);return `${days} day${days===1?'':'s'} ago`}
function residentAI(ai,id){const list=arr(ai?.summary?.residents);return list.find(x=>String(x.residentId)===String(id))||list[0]||null}
function alertEvents(){const name=clean(state.resident?.name,'').toLowerCase();return arr(state.boot?.events).filter(e=>{const acknowledged=Boolean(e.isAcknowledged??e.is_acknowledged);const rn=clean(e.residentName??e.resident_name,'').toLowerCase();return !acknowledged&&(!rn||rn===name)}).sort((x,y)=>new Date(y.timestamp||y.createdAt||0)-new Date(x.timestamp||x.createdAt||0))}
function sensorList(){return arr(state.a?.sensors)}
function cameraList(){return arr(state.boot?.cameras).filter(c=>c.isActive!==false&&c.is_active!==false)}
function isCaution(){const x=`${state.a?.aiLevel||''} ${state.a?.aiStatus||''} ${state.a?.actionLevel||''} ${state.resident?.alertLevel||''}`.toLowerCase();return /critical|immediate|warning|caution|watch|observe|follow|attention/.test(x)}
function isCritical(){const x=`${state.a?.aiLevel||''} ${state.a?.aiStatus||''} ${state.a?.actionLevel||''} ${state.resident?.alertLevel||''}`.toLowerCase();return /critical|immediate|emergency/.test(x)}
function offlineSensors(){return sensorList().filter(s=>s.isOnline!==true||s.isActive===false)}
function syncDisplay(){return state.lastLoaded?new Date(state.lastLoaded).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'Pending'}

function milestone(key){return arr(state.a?.routineMilestones).find(m=>String(m.key||m.name||'').toLowerCase().includes(key))||null}
function firstDay(){const m=milestone('first');const at=state.a?.firstMotionTodayAt;const typical=state.a?.typicalFirstActivityTime;if(m){return {value:clean(m.actualDisplay||m.actual||m.value,'Learning'),detail:clean(m.detail||m.status,'Learning today’s pattern'),tone:String(m.status||'').toLowerCase().includes('late')?'warn':'blue'}}if(at)return{value:fmtTime(at)||'Started',detail:typical?`Typical: ${typical}`:'First daytime activity',tone:'blue'};return{value:'Learning',detail:typical?`Typical: ${typical}`:'Waiting for daytime activity',tone:'blue'}}
function overnight(){const today=state.a?.overnightEpisodesToday,typ=state.a?.typicalOvernightEpisodes;if(today!==undefined&&today!==null){const above=typ!==undefined&&typ!==null&&Number(today)>Number(typ)+.5;return{value:String(today),detail:typ!==undefined&&typ!==null?`Typical: ${Number(typ).toFixed(Number(typ)%1?1:0)}`:'overnight activity events',tone:above?'warn':'blue'}}return{value:'Learning',detail:'Overnight routine is still being learned',tone:'blue'}}
function routine(){const score=state.a?.routineConsistencyScore,label=state.a?.routineConsistencyLabel;if(score!==undefined&&score!==null)return{value:`${score}%`,detail:label?`${label} routine`:'Routine consistency',tone:Number(score)>=70?'good':Number(score)>=45?'blue':'warn'};return{value:clean(label,'Learning'),detail:'Good Shepherd is learning the routine',tone:'blue'}}
function toneIcon(t){return t==='good'?'✓':t==='warn'?'!':t==='bad'?'!':'●'}
function bgClass(t){return t==='good'?'bg-good':t==='warn'?'bg-warn':t==='bad'?'bg-bad':t==='purple'?'bg-purple':'bg-blue'}

function heroPresentation(){const r=state.resident,a=state.a;if(isCritical())return{title:'A change may need immediate review',detail:clean(a?.actionSummary||a?.aiExplanation,`Good Shepherd noticed something that may require prompt follow-up for ${r.name}.`),badge:'Review now',tone:'bad',badgeIcon:'!'};if(isCaution())return{title:'A change may need review',detail:clean(a?.actionSummary||a?.aiExplanation,`Good Shepherd noticed something outside the usual pattern for ${r.name}.`),badge:'Review recommended',tone:'warn',badgeIcon:'!'};if(a?.overnightEpisodesToday!=null&&a?.typicalOvernightEpisodes!=null&&Number(a.overnightEpisodesToday)>Number(a.typicalOvernightEpisodes)+.5)return{title:'Overall monitoring looks stable',detail:`${r.name} is active today. Good Shepherd did notice more overnight activity than usual.`,badge:'One routine change noticed',tone:'blue',badgeIcon:'☾'};return{title:'Everything looks normal',detail:`${r.name} is being monitored and no urgent changes currently require attention.`,badge:'Normal monitoring',tone:'good',badgeIcon:'✓'}}
function renderHero(){const p=heroPresentation();$('heroCard').innerHTML=`<div class="hero-top"><div class="hero-orb" style="background:linear-gradient(135deg,${p.tone==='bad'?'#ff3b30':p.tone==='warn'?'#ff9500':p.tone==='blue'?'#007aff':'#34c759'},rgba(0,122,255,.72))">✦</div><div><div class="hero-eyebrow">Good Shepherd AI</div><div class="hero-title">${esc(p.title)}</div><p class="hero-detail">${esc(p.detail)}</p></div></div><div class="divider"></div><div class="hero-bottom"><div class="hero-badge ${p.tone}">${esc(p.badgeIcon)}&nbsp; ${esc(p.badge)}</div><div class="hero-checked">Checked ${esc(syncDisplay())}</div></div>`}

function findings(){const a=state.a,r=state.resident,out=[];if(a?.actionSummary&&isCaution())out.push({title:clean(a.actionTitle,'Routine change noticed'),detail:a.actionSummary,tone:isCritical()?'bad':'warn',icon:'!'});if(a?.patternStatus&&String(a.patternStatus).toLowerCase()!=='normal')out.push({title:clean(a.patternStatus,'Activity pattern'),detail:clean(a.patternExplanation,'Good Shepherd noticed a change from the usual pattern.'),tone:'warn',icon:'≈'});if(a?.trendDirection&&String(a.trendDirection).toLowerCase()!=='stable')out.push({title:`Activity trend: ${a.trendDirection}`,detail:clean(a.trendNarrative,'Good Shepherd is comparing recent activity with the established baseline.'),tone:'blue',icon:'↗'});if(a?.coverageStatus&&/partial|limited|attention|offline/i.test(a.coverageStatus))out.push({title:'Home coverage may need attention',detail:clean(a.coverageExplanation,'One or more monitored areas may not be reporting normally.'),tone:'warn',icon:'⌂'});if(a?.routineConsistencyLabel)out.push({title:`Routine: ${a.routineConsistencyLabel}`,detail:a.routineConsistencyScore!=null?`Routine consistency is ${a.routineConsistencyScore}%.`:'Good Shepherd is comparing today with the household’s usual pattern.',tone:'blue',icon:'∿'});if(!out.length)out.push({title:'Monitoring normally',detail:'No unusual routine changes are available to highlight yet.',tone:'good',icon:'✓'});return out.slice(0,3)}
function renderFindings(){$('findings').innerHTML=findings().map(f=>`<div class="finding"><div class="round-icon ${bgClass(f.tone)} ${f.tone}">${esc(f.icon)}</div><div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p></div></div>`).join('')}

function glanceCard(title,value,detail,icon,tone,view){return `<button class="glance-card" type="button" data-view="${view}"><div class="glance-icon ${bgClass(tone)} ${tone}">${icon}</div><div class="glance-label">${esc(title)}</div><div class="glance-value">${esc(value)}</div><div class="glance-detail">${esc(detail)}</div></button>`}
function renderGlance(){const f=firstDay(),o=overnight(),rt=routine(),alerts=alertEvents();$('glanceGrid').innerHTML=glanceCard('Day Started',f.value,f.detail,'☀',f.tone,'ai')+glanceCard('Overnight',o.value,o.detail,'☾',o.tone,'ai')+glanceCard('Routine',rt.value,rt.detail,'∿',rt.tone,'ai')+glanceCard('Needs Attention',alerts.length?String(alerts.length):'Nothing',alerts.length?`Open update${alerts.length===1?'':'s'} to review`:'No updates to review',alerts.length?'●':'✓',alerts.length?'warn':'good','updates')}

function latestActivity(){return clean(state.resident?.lastActivity||state.a?.residentLastActivity||relative(state.a?.lastMotionAt),'No recent activity reported')}
function systemSummaryText(){const sensors=sensorList(),connected=sensors.filter(s=>s.isOnline===true).length;if(!state.online)return 'Good Shepherd is reconnecting to the monitoring service.';if(!sensors.length)return 'Good Shepherd is connected. Sensor status is still loading.';if(offlineSensors().length)return `${connected} of ${sensors.length} sensors are connected. One or more sensors may need attention.`;return `All ${sensors.length} monitoring sensor${sensors.length===1?' is':'s are'} connected.`}
function dailySummary(){const p=heroPresentation();const a=state.a;let extra='';if(a?.motionCountToday!=null)extra=` Good Shepherd has recorded ${a.motionCountToday} activity event${Number(a.motionCountToday)===1?'':'s'} today.`;return `${p.detail}${extra}`}
function currentResponse(){switch(state.prompt){case'lastActivity':return `The latest household activity is ${latestActivity()}.`;case'needsAttention':{const alerts=alertEvents();return alerts.length?`There ${alerts.length===1?'is':'are'} ${alerts.length} open update${alerts.length===1?'':'s'} that may deserve review. ${clean(alerts[0]?.message,'Open Recent Updates for details.')}`:'Nothing currently needs attention. Good Shepherd has no open customer updates to review.'}case'systemHealth':return systemSummaryText();default:return dailySummary()}}
function renderBriefing(){$('briefingBubble').innerHTML=`<div class="ai-avatar">✦</div><div class="ai-message">${esc(currentResponse())}</div>`;const prompts=[['dailySummary','✦','How are things?'],['lastActivity','◴','Latest activity'],['needsAttention','!','Anything concerning?'],['systemHealth','⌁','Is monitoring working?']];$('promptChips').innerHTML=prompts.map(([id,ic,t])=>`<button class="prompt-chip ${state.prompt===id?'active':''}" data-prompt="${id}" type="button">${ic}&nbsp; ${esc(t)}</button>`).join('')}

function hourlyCounts(){const raw=arr(state.a?.hourlyMotionCounts);if(raw.length){const h=Array(24).fill(0);raw.forEach(x=>{const hour=num(x.hour??x.hourOfDay,-1);if(hour>=0&&hour<24)h[hour]=num(x.count??x.motionCount,0)});return h}return []}
function chartHTML(counts){if(!counts.length||Math.max(...counts)===0)return `<div class="empty-state">No hourly activity has been recorded yet today.</div>`;const max=Math.max(...counts,1);return `<div class="hourly-chart">${counts.map((c,i)=>`<div class="hour-bar-wrap"><div class="hour-bar" style="height:${Math.max(2,Math.round((c/max)*88))}px" title="${i}:00 — ${c}"></div><div class="hour-label">${[0,6,12,18,23].includes(i)?(i===0?'12a':i<12?`${i}a`:i===12?'12p':i===23?'11p':`${i-12}p`):''}</div></div>`).join('')}</div>`}
function renderActivity(){const a=state.a;if(!a){$('activityCard').innerHTML=`<div class="empty-state">Activity Data Unavailable</div>`;return}const counts=hourlyCounts();let active='';if(clean(a.mostActiveRoomToday,'—')!=='—')active=`<div class="active-area">⌂&nbsp; Most active area: ${esc(a.mostActiveRoomToday)}</div>`;$('activityCard').innerHTML=`<div class="activity-head"><div><div class="activity-title">▥&nbsp; Today’s Activity</div><div class="activity-sub">Movement detected throughout the day</div></div></div>${chartHTML(counts)}<div class="metric-grid"><div class="metric-card"><div class="metric-icon">●</div><div class="metric-value">${num(a.motionCountToday)}</div><div class="metric-title">Today</div><div class="metric-detail">activity events</div></div><div class="metric-card"><div class="metric-icon">◴</div><div class="metric-value">${num(a.motionCountLastHour)}</div><div class="metric-title">Last Hour</div><div class="metric-detail">recent events</div></div></div>${active}`}

function eventTitle(e){return clean(e.message||e.sourceName||e.alertLevel,'Activity update')}
function eventDetail(e){return clean(e.timeText||fmtDate(e.timestamp||e.createdAt||e.time),'Recent update')}
function eventTone(e){const l=String(e.alertLevel||'').toLowerCase();return /critical|immediate/.test(l)?'bad':/warning|caution|watch|observe/.test(l)?'warn':'blue'}
function timelineHTML(icon,tone,title,detail,index=''){return `<button class="timeline" type="button" ${index!==''?`data-alert-index="${index}"`:''}><div class="round-icon ${bgClass(tone)} ${tone}">${esc(icon)}</div><div><h3>${esc(title)}</h3><p>${esc(detail)}</p></div></button>`}
function renderUpdates(){const alerts=alertEvents();const shown=state.showAllUpdates?alerts:alerts.slice(0,2);$('updatesList').innerHTML=timelineHTML('●','blue','Latest household activity',latestActivity())+(alerts.length?shown.map((e,i)=>timelineHTML('!',eventTone(e),eventTitle(e),eventDetail(e),i)).join(''):timelineHTML('✓','good','No action needed','There are no updates that need review right now.'));$('toggleUpdates').classList.toggle('hidden',alerts.length<=2);$('toggleUpdates').textContent=state.showAllUpdates?'Show Less':'View All'}

function coverageDisplay(){const a=state.a;if(a?.coverageStatus)return clean(a.coverageStatus);const rooms=arr(a?.assignedRooms);return rooms.length?`${rooms.length} monitored area${rooms.length===1?'':'s'}`:'Status unavailable'}
function renderSystem(){const sensors=sensorList(),connected=sensors.filter(s=>s.isOnline===true).length,attention=!state.online||offlineSensors().length>0,known=sensors.length>0,title=!known?'Sensor Status Pending':attention?'Attention Needed':'All Systems Normal',tone=!known?'blue':attention?'warn':'good',summary=!known?'Sensor status unavailable':`${connected} of ${sensors.length} sensors connected`;$('systemCard').innerHTML=`<button id="systemToggle" class="system-summary" type="button"><div class="square-icon ${bgClass(tone)} ${tone}">${toneIcon(tone)}</div><div><h3>Monitoring System — ${esc(title)}</h3><p>${esc(summary)}</p></div><div class="chevron ${state.systemOpen?'open':''}">›</div></button><div id="systemDetails" class="system-details ${state.systemOpen?'':'hidden'}"><div class="divider" style="margin-top:0"></div>${systemRow('⌁','Monitoring service',state.online?'Available':'Needs attention','system')}${systemRow('◉','Sensors',summary,'system')}${systemRow('⌂','Home coverage',coverageDisplay(),'coverage')}${systemRow('▣','Cameras',cameraList().length?`${cameraList().length} active`:'Not enabled','coverage')}${systemRow('↻','Last checked',syncDisplay(),'system')}</div>`}
function systemRow(icon,label,value,view){return `<button class="system-row tap-card" type="button" data-view="${view}"><span class="row-icon">${icon}</span><span class="row-label">${esc(label)}</span><span class="row-value">${esc(value)}</span></button>`}

function renderAll(){renderHero();renderFindings();renderGlance();renderBriefing();renderActivity();renderUpdates();renderSystem();$('onlineDot').classList.toggle('offline',!state.online);$('onlineText').textContent=state.online?'Monitoring Active':'Reconnecting'}

function showLogin(){state.detail=null;$('dashboard').classList.add('hidden');$('detailView').classList.add('hidden');$('login').classList.remove('hidden');$('codeInput').value='';updateDigits();$('loginError').textContent='';$('loginStatus').textContent=''}
function showDashboard(){$('login').classList.add('hidden');$('detailView').classList.add('hidden');$('dashboard').classList.remove('hidden');state.detail=null;window.scrollTo(0,0)}
function openDetail(type,payload=null){state.detail={type,payload};$('dashboard').classList.add('hidden');$('detailView').classList.remove('hidden');renderDetail(type,payload);window.scrollTo(0,0)}
function renderDetail(type,payload){const r=state.resident,a=state.a,alerts=alertEvents(),sensors=sensorList(),cams=cameraList();let title='Details',html=`<div class="readonly">🔒 Customer view • Read only</div>`;const header=`<section class="detail-card resident-header"><div class="big-icon ${isCaution()?'bg-warn warn':'bg-good good'}">${isCaution()?'!':'✓'}</div><div><h2>${esc(r.name||'Your Home')}</h2><p>${esc(clean(r.location,'Home'))}</p></div></section>`;
 if(type==='ai'){title='Activity & AI';html+=header;html+=aiDetailHTML(a,r)}
 else if(type==='alert'){title='Update Detail';const e=payload||{};html+=`<section class="detail-card"><h2 class="${eventTone(e)}">${esc(clean(e.alertLevel,'Update'))}</h2><p class="alert-detail-title">${esc(eventTitle(e))}</p><p style="color:var(--secondary)">${esc(eventDetail(e))}</p>${e.locationName?`<div class="divider"></div><p>Location: ${esc(e.locationName)}</p>`:''}</section>`}
 else {title=type==='coverage'?'Monitoring Coverage':type==='updates'?'Open Updates':type==='system'?'System Information':'Household';html+=header;if(type==='overview'||type==='status')html+=statusDetailHTML(r,alerts);if(type==='overview'||type==='updates'||type==='status')html+=updatesDetailHTML(alerts);if(type==='overview'||type==='coverage')html+=coverageDetailHTML(cams);if(type==='overview'||type==='system'||type==='coverage')html+=systemDetailHTML(sensors)}
 $('detailTitle').textContent=title;$('detailContent').innerHTML=html;bindDetail()}
function detailRow(label,value){return `<div class="detail-row"><span class="row-label">${esc(label)}</span><span class="row-value">${esc(value)}</span></div>`}
function statusDetailHTML(r,alerts){return `<section class="detail-card"><h2>▣&nbsp; Current Status</h2><div class="detail-row"><span class="row-label ${isCaution()?'warn':'good'}" style="font-size:19px;font-weight:700">${esc(clean(r.alertLevel,state.a?.aiLevel||'Normal'))}</span><span class="row-value">${esc(clean(r.statusText||state.a?.residentStatusText,'Monitoring active'))}</span></div><div class="divider"></div>${detailRow('Last activity',latestActivity())}${detailRow('Open warnings',String(alerts.length))}</section>`}
function updatesDetailHTML(alerts){return `<section class="detail-card"><h2>●&nbsp; Open Updates</h2>${alerts.length?alerts.map((e,i)=>timelineHTML('!',eventTone(e),eventTitle(e),eventDetail(e),i)).join(''):`<div class="good" style="font-size:14px">✓&nbsp; Nothing currently needs attention</div>`}</section>`}
function coverageDetailHTML(cams){return `<section class="detail-card"><h2>◉&nbsp; Monitoring Coverage</h2>${detailRow('Connection',state.online?'Connected':'Unavailable')}${detailRow('Camera access',cams.length?`${cams.length} active`:'Not enabled')}${cams.length?`<div class="divider"></div>${cams.map(c=>`<div class="system-row"><span class="row-icon blue">▣</span><span class="row-label"><strong>${esc(clean(c.sourceName||c.source_name,'Camera'))}</strong><br><small style="color:var(--secondary)">${c.isActive===false?'Inactive':'Active'}</small></span></div>`).join('')}`:''}</section>`}
function sensorName(s){return clean(s.displayName||s.sensorName||s.name||s.sourceName,'Sensor')}
function systemDetailHTML(sensors){const connected=sensors.filter(s=>s.isOnline===true).length,attention=!state.online||offlineSensors().length>0;return `<section class="detail-card"><h2>▦&nbsp; System Information</h2>${detailRow('Service',state.online?'Connected':'Reconnecting')}${detailRow('Sensor health',sensors.length?`${connected} of ${sensors.length} connected`:'Status unavailable')}${detailRow('Overall status',sensors.length?(attention?'Attention needed':'All systems normal'):'Sensor status pending')}${detailRow('Last update',syncDisplay())}${sensors.length?`<div class="divider"></div><strong style="font-size:14px">Sensors</strong>${sensors.map(sensorHTML).join('')}`:''}<p style="color:var(--secondary);font-size:12px">This customer screen provides status information only. System configuration and administrative controls are not available here.</p></section>`}
function sensorHTML(s){const on=s.isOnline===true,active=s.isActive!==false;return `<div class="sensor-row"><div class="sensor-status ${on?'good':'warn'}">${on?'✓':'!'}</div><div class="sensor-main"><strong>${esc(sensorName(s))}</strong><p>${esc(clean(s.sensorType||s.type,'Sensor'))}</p><div class="pills"><span class="pill ${on?'bg-good good':'bg-warn warn'}">${on?'Online':'Offline'}</span><span class="pill ${active?'bg-blue blue':''}">${active?'Active':'Inactive'}</span></div><p>Last communication: ${esc(clean(s.lastSeenDisplayText||relative(s.lastSeenAt||s.lastSeen),'Not available'))}</p></div></div>`}
function aiDetailHTML(a,r){if(!a)return `<section class="detail-card empty-state">AI Details Unavailable</section>`;const baseline=a.baselineDayCount??0,score=a.routineConsistencyScore,sim=score!=null?`${score}%`:'Learning',trend=clean(a.trendDirection,'Learning'),change=a.sevenDayChangePercent!=null?`${a.sevenDayChangePercent>0?'+':''}${Number(a.sevenDayChangePercent).toFixed(1)}%`:'Learning',expected=a.expectedMotionCountLow!=null&&a.expectedMotionCountHigh!=null?`${a.expectedMotionCountLow}–${a.expectedMotionCountHigh}`:'—',assigned=arr(a.assignedRooms).join(', ')||'—',active=arr(a.activeRoomsToday).join(', ')||'—';return `<section class="detail-card"><h2>✦&nbsp; ${esc(r.name)}</h2><p>${esc(clean(r.statusText||a.residentStatusText,'Household activity summary'))}</p><p style="color:var(--secondary);font-size:12px">Latest activity: ${esc(latestActivity())}</p></section><section class="detail-card"><h2>AI Deep Dive</h2><div class="metric-grid"><div class="metric-card"><div class="metric-value">${esc(sim)}</div><div class="metric-title">Routine Match</div><div class="metric-detail">today vs normal</div></div><div class="metric-card"><div class="metric-value">${baseline}d</div><div class="metric-title">Baseline</div><div class="metric-detail">usable days</div></div></div><p>${esc(clean(a.aiExplanation,'Good Shepherd is analyzing household activity.'))}</p>${detailRow('Activity deviation',expected==='—'?'Learning':`${a.motionCountToday} today vs ${expected}`)}${detailRow('Peak hour',peakHour(a))}${detailRow('Daily rhythm',daypart(a))}${detailRow('Room concentration',clean(a.mostActiveRoomToday,'—'))}${detailRow('Baseline quality',baseline>=7?'Established':baseline>=3?'Developing':'Learning')}</section><section class="detail-card"><h2>Routine & Trends</h2>${detailRow('Routine consistency',score!=null?`${score}% ${clean(a.routineConsistencyLabel,'')}`.trim():'Learning')}${detailRow('Trend',trend)}${detailRow('Trend coverage',clean(a.trendCoverageStatus,'Learning'))}${detailRow('7-day comparison',change)}${detailRow('First daytime activity',clean(a.typicalFirstActivityTime,'Learning'))}${detailRow('Typical last activity',clean(a.typicalLastActivityTime,'Learning'))}${detailRow('Overnight activity',a.overnightEpisodesToday!=null?`${a.overnightEpisodesToday} today`:'Learning')}${a.trendNarrative?`<div class="divider"></div><p style="color:var(--secondary)">${esc(a.trendNarrative)}</p>`:''}</section><section class="detail-card"><h2>Today’s Activity</h2>${chartHTML(hourlyCounts())}<div class="metric-grid"><div class="metric-card"><div class="metric-value">${num(a.motionCountToday)}</div><div class="metric-title">Today</div><div class="metric-detail">motion events</div></div><div class="metric-card"><div class="metric-value">${num(a.motionCountLastHour)}</div><div class="metric-title">Last Hour</div><div class="metric-detail">recent events</div></div></div>${detailRow('Most active area',clean(a.mostActiveRoomToday,'—'))}${detailRow('Last motion',clean(a.lastMotionMessage||relative(a.lastMotionAt),'Not available'))}</section><section class="detail-card"><h2>Pattern</h2>${detailRow('Status',clean(a.patternStatus,'Learning'))}<p style="color:var(--secondary)">${esc(clean(a.patternExplanation,'Good Shepherd is learning this routine.'))}</p>${detailRow('Expected range',expected)}${detailRow('Daily median',a.baselineMotionMedian!=null?String(Math.round(a.baselineMotionMedian)):'—')}${detailRow('Same-time median',a.baselineSameTimeMedian!=null?String(Math.round(a.baselineSameTimeMedian)):'—')}${detailRow('Baseline method',clean(a.baselineMethod,'Learning'))}</section><section class="detail-card"><h2>Home Coverage</h2>${detailRow('Coverage',clean(a.coverageStatus,'Learning'))}<p style="color:var(--secondary)">${esc(clean(a.coverageExplanation,'Coverage information is still being learned.'))}</p>${detailRow('Monitored areas',assigned)}${detailRow('Active today',active)}</section><section class="detail-card"><h2>Good Shepherd AI</h2><p>${esc(clean(a.aiExplanation,'AI status unavailable.'))}</p>${detailRow('Confidence',a.aiConfidenceScore!=null?`${clean(a.aiConfidence,'')} ${a.aiConfidenceScore}%`.trim():clean(a.aiConfidence,'Learning'))}</section>`}
function peakHour(a){const h=hourlyCounts();if(!h.length||Math.max(...h)===0)return 'Learning';const i=h.indexOf(Math.max(...h));return `${i===0?'12 AM':i<12?`${i} AM`:i===12?'12 PM':`${i-12} PM`}`}
function daypart(a){const h=hourlyCounts();if(!h.length)return 'Learning';const sums={Morning:h.slice(5,12).reduce((x,y)=>x+y,0),Afternoon:h.slice(12,17).reduce((x,y)=>x+y,0),Evening:h.slice(17,22).reduce((x,y)=>x+y,0),Overnight:h.slice(22).concat(h.slice(0,5)).reduce((x,y)=>x+y,0)};const best=Object.entries(sums).sort((x,y)=>y[1]-x[1])[0];return best&&best[1]>0?`${best[0]} is most active`:'Learning'}

function bindDetail(){document.querySelectorAll('#detailContent [data-alert-index]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.alertIndex);openDetail('alert',alertEvents()[i])})}
async function load(){const dash=$('dashboard');dash.classList.add('loading-screen');try{const [boot,ai]=await Promise.all([api('/customer/bootstrap'),api('/customer/ai/dashboard')]);state.boot=boot;state.ai=ai;state.resident=boot.resident||{};state.a=residentAI(ai,state.resident.id);state.online=true;state.lastLoaded=Date.now();renderAll()}catch(err){state.online=false;if(err.status===401||err.status===403){localStorage.removeItem(TOKEN_KEY);showLogin();$('loginError').textContent='Your session expired. Enter your 4-digit code again.';return}if(state.resident){renderAll()}else{showLogin();$('loginError').textContent=err.message}}finally{dash.classList.remove('loading-screen')}}

function updateDigits(){const code=$('codeInput').value;document.querySelectorAll('.digit-box').forEach((box,i)=>{box.textContent=i<code.length?code[i]:'';box.classList.toggle('active',i===code.length&&code.length<4)})}
async function submitCode(){const code=$('codeInput').value;if(code.length!==4)return;$('loginError').textContent='';$('loginStatus').textContent='Preparing your dashboard…';$('loginStatus').classList.add('loading');try{const j=await api('/customer/access',{method:'POST',body:JSON.stringify({code})});if(j.mode==='staff')throw new Error('Staff access is available in the Good Shepherd iOS app.');if(!j.token)throw new Error('The server did not return a customer session.');localStorage.setItem(TOKEN_KEY,j.token);showDashboard();await load()}catch(err){$('loginError').textContent=err.message;$('codeInput').value='';updateDigits();$('codeInput').focus()}finally{$('loginStatus').textContent='';$('loginStatus').classList.remove('loading')}}
$('codeInput').addEventListener('input',()=>{const v=$('codeInput').value.replace(/\D/g,'').slice(0,4);$('codeInput').value=v;$('loginError').textContent='';updateDigits();if(v.length===4)submitCode()});
$('digitBoxes').onclick=()=>$('codeInput').focus();$('digitBoxes').onkeydown=e=>{if(e.key==='Enter'||e.key===' ')$('codeInput').focus()};$('loginForm').onsubmit=e=>{e.preventDefault();submitCode()};
$('refreshButton').onclick=load;$('briefRefresh').onclick=()=>{state.prompt='dailySummary';renderBriefing()};$('heroCard').onclick=()=>openDetail('overview');$('viewDetailsButton').onclick=()=>openDetail('ai');$('briefingBubble').onclick=()=>openDetail('ai');$('activityCard').onclick=()=>openDetail('ai');$('monitoringButton').onclick=()=>openDetail('system');$('toggleUpdates').onclick=()=>{state.showAllUpdates=!state.showAllUpdates;renderUpdates()};$('backButton').onclick=showDashboard;
$('signOutButton').onclick=async()=>{try{await api('/customer/logout',{method:'POST'})}catch{}localStorage.removeItem(TOKEN_KEY);showLogin();setTimeout(()=>$('codeInput').focus(),100)};
document.addEventListener('click',e=>{const chip=e.target.closest('[data-prompt]');if(chip){state.prompt=chip.dataset.prompt;renderBriefing();return}const view=e.target.closest('[data-view]');if(view){openDetail(view.dataset.view);return}const sys=e.target.closest('#systemToggle');if(sys){state.systemOpen=!state.systemOpen;renderSystem();return}const al=e.target.closest('#updatesList [data-alert-index]');if(al){openDetail('alert',alertEvents()[Number(al.dataset.alertIndex)]);}});


/* ===== PWA INSTALL ===== */
let deferredInstallPrompt = null;

function isStandaloneMode(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isiOSDevice(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isAndroidDevice(){
  return /android/i.test(navigator.userAgent);
}
function installInstructionHTML(){
  if(isiOSDevice()){
    return `
      <p>Apple requires this final confirmation from Safari. It only takes a few seconds.</p>
      <div class="install-step"><div class="install-step-number">1</div><div><strong>Open this page in Safari</strong><span>If you are already in Safari, continue to step 2.</span></div></div>
      <div class="install-step"><div class="install-step-number">2</div><div><strong>Tap the Share button</strong><span>Tap the square with the upward arrow in Safari.</span></div></div>
      <div class="install-step"><div class="install-step-number">3</div><div><strong>Tap “Add to Home Screen”</strong><span>Then tap Add. Good Shepherd will appear with your other apps.</span></div></div>`;
  }
  if(isAndroidDevice()){
    return `
      <p>Your browser has not exposed the automatic install prompt yet. You can still install Good Shepherd directly.</p>
      <div class="install-step"><div class="install-step-number">1</div><div><strong>Tap Chrome’s ⋮ menu</strong><span>Use the menu in the upper-right corner.</span></div></div>
      <div class="install-step"><div class="install-step-number">2</div><div><strong>Tap “Install app” or “Add to Home screen”</strong><span>Chrome may use either label depending on the device.</span></div></div>
      <div class="install-step"><div class="install-step-number">3</div><div><strong>Confirm Install</strong><span>The Good Shepherd icon will be added to the phone.</span></div></div>`;
  }
  return `
    <p>Install Good Shepherd from your browser’s app/install menu. On a phone, use “Add to Home Screen” or “Install app.”</p>`;
}
function refreshInstallUI(){
  const area=$('installArea'), btn=$('installAppButton'), installed=$('installedMessage');
  if(!area || !btn || !installed) return;
  if(isStandaloneMode()){
    btn.classList.add('hidden');
    $('continueBrowserButton')?.classList.add('hidden');
    installed.classList.remove('hidden');
  }else{
    btn.classList.remove('hidden');
    installed.classList.add('hidden');
  }
}
function openInstallHelp(){
  const modal=$('installModal');
  $('installInstructions').innerHTML=installInstructionHTML();
  modal.classList.remove('hidden');
}
function closeInstallHelp(){
  $('installModal')?.classList.add('hidden');
}
window.addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  deferredInstallPrompt=e;
  refreshInstallUI();
});
window.addEventListener('appinstalled', ()=>{
  deferredInstallPrompt=null;
  refreshInstallUI();
  closeInstallHelp();
});
window.matchMedia('(display-mode: standalone)').addEventListener?.('change',refreshInstallUI);

$('installAppButton').onclick=async()=>{
  if(isStandaloneMode()){ refreshInstallUI(); return; }
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    try{ await deferredInstallPrompt.userChoice; }catch{}
    deferredInstallPrompt=null;
    refreshInstallUI();
    return;
  }
  openInstallHelp();
};
$('continueBrowserButton').onclick=()=>{ $('codeInput').focus(); };
$('closeInstallModal').onclick=closeInstallHelp;
$('installModal').onclick=e=>{ if(e.target===$('installModal')) closeInstallHelp(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeInstallHelp(); });
refreshInstallUI();

(async()=>{if('serviceWorker'in navigator)navigator.serviceWorker.register('service-worker.js').catch(()=>{});setTimeout(()=>$('splash').classList.add('fade'),1300);setTimeout(()=>$('splash').remove(),1900);if(!token()){showLogin();setTimeout(()=>$('codeInput').focus(),250);return}try{await api('/customer/session');showDashboard();await load()}catch{localStorage.removeItem(TOKEN_KEY);showLogin();setTimeout(()=>$('codeInput').focus(),250)}})();
