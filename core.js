/* ============================================================
   Watchkeeper core — time zones, parsing, recurrence, migration.
   Kept free of DOM access so it can be exercised headlessly.
   ============================================================ */

/* ---------------------------------------------------------- time zones --- */

const TZ_CHOICES = [
  {id:'local',           label:'Device local time'},
  {id:'Asia/Colombo',    label:'Asia/Colombo (+05:30)'},
  {id:'Asia/Singapore',  label:'Asia/Singapore (+08:00)'},
  {id:'UTC',             label:'UTC'}
];

function deviceTz(){
  try{ return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch(e){ return 'local'; }
}

/* Offset (ms) of a named zone at a given instant. */
function tzOffsetMs(tz, instant){
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
  const p = {};
  dtf.formatToParts(instant).forEach(x => { if(x.type !== 'literal') p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

/* Wall-clock fields in a zone -> epoch ms. Iterates so DST-shifted zones settle.
   Asia/Colombo and Asia/Singapore have no DST, so these resolve on the first pass. */
function wallToEpoch(tz, y, mo, d, hh, mi){
  if(tz === 'local' || !tz) return new Date(y, mo, d, hh, mi, 0, 0).getTime();
  const target = Date.UTC(y, mo, d, hh, mi, 0);
  let guess = target;
  for(let i = 0; i < 4; i++){
    const off = tzOffsetMs(tz, new Date(guess));
    const next = target - off;
    if(next === guess) break;
    guess = next;
  }
  return guess;
}

/* epoch ms -> wall-clock fields in a zone */
function epochToWall(tz, ms){
  if(tz === 'local' || !tz){
    const d = new Date(ms);
    return {y:d.getFullYear(), mo:d.getMonth(), d:d.getDate(), hh:d.getHours(), mi:d.getMinutes()};
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  });
  const p = {};
  dtf.formatToParts(new Date(ms)).forEach(x => { if(x.type !== 'literal') p[x.type] = x.value; });
  return {y:+p.year, mo:+p.month - 1, d:+p.day, hh:(+p.hour) % 24, mi:+p.minute};
}

/* ISO 8601 with a real UTC offset, which is what the Teams scheduling link
   requires — a bare local time there is read as the organiser's zone and the
   meeting lands at the wrong hour for everyone else. */
function isoWithOffset(ms, tz){
  const w = epochToWall(tz || 'local', ms);
  let offMin;
  if(!tz || tz === 'local'){
    offMin = -new Date(ms).getTimezoneOffset();
  } else {
    offMin = Math.round(tzOffsetMs(tz, new Date(ms)) / 60000);
  }
  const sign = offMin < 0 ? '-' : '+';
  const a = Math.abs(offMin);
  return w.y + '-' + pad2(w.mo + 1) + '-' + pad2(w.d) + 'T' +
         pad2(w.hh) + ':' + pad2(w.mi) + ':00' +
         sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
}

/* Teams opens its scheduling form already filled in. Attendees are left to
   the directory picker there, which knows the company address book. */
function teamsMeetingUrl(it){
  if(!it || it.due == null) return null;
  const mins = it.durationMin || 30;
  const enc = s => encodeURIComponent(String(s || ''));   // %20, never '+'
  const body = [
    it.notes || '',
    it.vessel ? 'Vessel/company: ' + it.vessel : '',
    it.ref ? 'Ref: ' + it.ref : ''
  ].filter(Boolean).join('\n');
  const q = [
    'subject=' + enc(it.title),
    'startTime=' + enc(isoWithOffset(it.due, it.tz)),
    'endTime=' + enc(isoWithOffset(it.due + mins * 60000, it.tz))
  ];
  if(body) q.push('content=' + enc(body));
  return 'https://teams.microsoft.com/l/meeting/new?' + q.join('&');
}

function tzLabel(tz){
  if(!tz || tz === 'local') return '';
  const f = TZ_CHOICES.find(t => t.id === tz);
  return f ? f.id.split('/').pop().replace('_',' ') : tz;
}

/* ---------------------------------------------------------- calendar maths --- */

function daysInMonth(y, mo){ return new Date(y, mo + 1, 0).getDate(); }

function validDate(y, mo, d){
  if(!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return false;
  if(mo < 0 || mo > 11) return false;
  if(d < 1) return false;
  return d <= daysInMonth(y, mo);
}
function validTime(hh, mi){
  return Number.isInteger(hh) && Number.isInteger(mi) && hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59;
}

const REPEATS = [
  {id:'',         label:'Does not repeat'},
  {id:'daily',    label:'Every day'},
  {id:'weekdays', label:'Every weekday (Mon–Fri)'},
  {id:'weekly',   label:'Every week'},
  {id:'monthly',  label:'Every month'}
];

/* Next occurrence strictly after `after`, computed from the SERIES ANCHOR so a
   snoozed single occurrence never shifts the whole schedule.
   `anchorDay` carries the intended day-of-month for monthly series, so a series
   anchored on the 31st still fires on the 30th in November and the 28th in
   February without permanently losing its day. */
function nextOccurrence(anchorMs, repeat, tz, after, anchorDay){
  if(!repeat) return null;
  const limit = (after == null ? Date.now() : after);
  let w = epochToWall(tz, anchorMs);
  const wantDay = anchorDay || w.d;
  let out = anchorMs;
  let guard = 0;

  while(out <= limit && guard++ < 5000){
    if(repeat === 'daily'){
      w.d += 1;
    } else if(repeat === 'weekly'){
      w.d += 7;
    } else if(repeat === 'weekdays'){
      w.d += 1;
    } else if(repeat === 'monthly'){
      w.mo += 1;
      if(w.mo > 11){ w.mo = 0; w.y += 1; }
      w.d = Math.min(wantDay, daysInMonth(w.y, w.mo));
    }
    // normalise day overflow for the non-monthly cases
    if(repeat !== 'monthly'){
      const norm = new Date(Date.UTC(w.y, w.mo, w.d));
      w.y = norm.getUTCFullYear(); w.mo = norm.getUTCMonth(); w.d = norm.getUTCDate();
    }
    out = wallToEpoch(tz, w.y, w.mo, w.d, w.hh, w.mi);

    if(repeat === 'weekdays'){
      const dow = new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay();
      if(dow === 0 || dow === 6) out = limit;  // keep walking to the next weekday
    }
  }
  return out;
}

/* ---------------------------------------------------------- parsing --- */

const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const WD_SHORT = {sun:0,mon:1,tue:2,tues:2,wed:3,weds:3,thu:4,thur:4,thurs:4,fri:5,sat:6};
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MON_SHORT = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
const NUMWORDS = {a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,fifteen:15,twenty:20,thirty:30,forty:40,'forty-five':45,'forty five':45,sixty:60,half:30};

const KIND_LABEL = {meeting:'Meeting', followup:'Follow-up', call:'Call', task:'Task'};

/* Speech recognisers return numbers as words at least as often as digits —
   "eleven thirty", "half past four", "forty five minutes". Everything below
   turns those into the digits the rest of the parser expects. */
const HOURWORD = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,
  eighteen:18,nineteen:19,twenty:20,'twenty one':21,'twenty two':22,'twenty three':23};
const MINWORD = {"o'clock":0,oclock:0,'o clock':0,five:5,ten:10,fifteen:15,twenty:20,
  'twenty five':25,thirty:30,'thirty five':35,forty:40,'forty five':45,fifty:50,'fifty five':55};
const UNIT_AFTER = '(?!\\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|o\'?clock))';

/* Case is preserved so vessel and company names survive ("CMA CGM"). */
function normalizeSpokenNumbers(text){
  let s = ' ' + String(text) + ' ';
  const hours = Object.keys(HOURWORD).sort((a,b) => b.length - a.length).join('|');
  const mins  = Object.keys(MINWORD).filter(k => !/clock/.test(k)).sort((a,b) => b.length - a.length).join('|');
  const low = k => String(k).toLowerCase();

  s = s.replace(new RegExp('\\bhalf\\s+past\\s+(' + hours + ')\\b','gi'),
    (_, h) => ' ' + HOURWORD[low(h)] + ':30 ');
  s = s.replace(new RegExp('\\b(?:a\\s+)?quarter\\s+past\\s+(' + hours + ')\\b','gi'),
    (_, h) => ' ' + HOURWORD[low(h)] + ':15 ');
  s = s.replace(new RegExp('\\b(?:a\\s+)?quarter\\s+to\\s+(' + hours + ')\\b','gi'),
    (_, h) => ' ' + ((HOURWORD[low(h)] + 23) % 24) + ':45 ');

  // "eleven thirty" -> 11:30, but never "two hours" or "forty five minutes"
  s = s.replace(new RegExp('\\b(' + hours + ')\\s+(' + mins + ')\\b' + UNIT_AFTER,'gi'),
    (_, h, m) => ' ' + HOURWORD[low(h)] + ':' + pad2(MINWORD[low(m)]) + ' ');

  s = s.replace(new RegExp("\\b(" + hours + ")\\s+o'?\\s?clock\\b",'gi'),
    (_, h) => ' ' + HOURWORD[low(h)] + ' ');

  /* Compound tens BEFORE single words, or "forty five minutes" is torn into
     "forty" and "5" and the duration is lost. */
  s = s.replace(/\btwenty[\s-]five\b/gi, ' 25 ');
  s = s.replace(/\bthirty[\s-]five\b/gi, ' 35 ');
  s = s.replace(/\bforty[\s-]five\b/gi, ' 45 ');
  s = s.replace(/\bfifty[\s-]five\b/gi, ' 55 ');
  s = s.replace(/\bthirty\b/gi, ' 30 ');
  s = s.replace(/\bforty\b/gi, ' 40 ');
  s = s.replace(/\bfifty\b/gi, ' 50 ');
  s = s.replace(/\bsixty\b/gi, ' 60 ');

  // remaining standalone number words -> digits (also helps "in two hours")
  s = s.replace(new RegExp('\\b(' + hours + ')\\b','gi'), (_, h) => ' ' + HOURWORD[low(h)] + ' ');

  return s.replace(/\s{2,}/g,' ').trim();
}

function detectKind(t){
  const s = t.toLowerCase();
  if(/\bfollow[\s-]?up\b|\bfollowup\b|\bchase\b|\brevert\b|\bremind .* about\b/.test(s)) return 'followup';
  if(/\bcall\b|\bphone\b|\bdial\b|\bring\b/.test(s)) return 'call';
  if(/\bmeeting\b|\bmeet\b|\bzoom\b|\bteams\b|\bconference\b|\bsurvey\b|\bvisit\b|\binspection\b|\battend\b/.test(s)) return 'meeting';
  return 'task';
}

/* Parse free text into an unsaved DRAFT. Nothing is committed from here —
   the draft is always shown for confirmation first. */
function parseDraft(raw, now, defaultTz){
  now = now || new Date();
  /* Date and time are read from the number-normalised text; `heard` keeps the
     original words so the card still shows what was actually said. */
  const text = normalizeSpokenNumbers(raw);
  const s = ' ' + text.toLowerCase().replace(/[,]/g,' ') + ' ';
  const cuts = [];
  const mark = m => { if(m && m.index != null) cuts.push([m.index, m.index + m[0].length]); };

  const draft = {
    title:'', heard:String(raw).trim(), kind:detectKind(raw),
    y:null, mo:null, d:null, hh:null, mi:0,
    tz: defaultTz || 'local',
    repeat:'', anchorDay:null,
    notes:'', vessel:'', ref:'', priority:'normal', durationMin:30,
    assumedDate:false, assumedTime:false, ambiguousTime:false,
    ambiguousOptions:null, errors:[], noTime:false
  };

  /* ---- explicit time zone in the wording ---- */
  let m = s.match(/\b(colombo|sri lanka|lanka|sl)\s*(?:time|tz)?\b/);
  if(m && /\b(time|tz)\b/.test(m[0])){ mark(m); draft.tz = 'Asia/Colombo'; }
  m = s.match(/\b(singapore|sgt|sing)\s*(?:time|tz)\b/);
  if(m){ mark(m); draft.tz = 'Asia/Singapore'; }
  m = s.match(/\bsgt\b/);
  if(m){ mark(m); draft.tz = 'Asia/Singapore'; }
  m = s.match(/\b(utc|gmt|zulu)\b/);
  if(m){ mark(m); draft.tz = 'UTC'; }

  /* ---- repeat ---- */
  let rm = s.match(/\bevery\s+(day|morning|weekday|weekdays|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/)
        || s.match(/\b(daily|weekly|monthly)\b/);
  if(rm){
    mark(rm);
    const w = rm[1];
    if(w === 'day' || w === 'daily' || w === 'morning') draft.repeat = 'daily';
    else if(w === 'weekday' || w === 'weekdays') draft.repeat = 'weekdays';
    else if(w === 'week' || w === 'weekly') draft.repeat = 'weekly';
    else if(w === 'month' || w === 'monthly') draft.repeat = 'monthly';
    else draft.repeat = 'weekly';
  }

  /* ---- relative offsets ("in 20 minutes") resolve to an exact instant ---- */
  m = s.match(/\bin\s+(a|an|\d{1,4}|one|two|three|four|five|six|seven|eight|ten|fifteen|twenty|thirty|forty five|forty-five|sixty|half)\s*(?:an\s+)?(min|mins|minute|minutes|hour|hours|hr|hrs|day|days|week|weeks)\b/);
  if(m){
    mark(m);
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1],10) : (NUMWORDS[m[1]] || 1);
    const u = m[2];
    const t = new Date(now.getTime());
    if(u.startsWith('min')) t.setMinutes(t.getMinutes() + n);
    else if(u.startsWith('h')) t.setHours(t.getHours() + n);
    else if(u.startsWith('d')) t.setDate(t.getDate() + n);
    else if(u.startsWith('w')) t.setDate(t.getDate() + 7 * n);
    t.setSeconds(0,0);
    draft.tz = 'local';
    const w = epochToWall('local', t.getTime());
    Object.assign(draft, {y:w.y, mo:w.mo, d:w.d, hh:w.hh, mi:w.mi});
    draft.title = cleanTitle(text, cuts);
    return draft;
  }

  /* ---- date ---- */
  const nowWall = epochToWall(draft.tz, now.getTime());
  const todayUTC = Date.UTC(nowWall.y, nowWall.mo, nowWall.d);
  const setFromUTC = ms => {
    const dd = new Date(ms);
    draft.y = dd.getUTCFullYear(); draft.mo = dd.getUTCMonth(); draft.d = dd.getUTCDate();
  };
  let haveDate = false;

  m = s.match(/\bday after tomorrow\b/);
  if(m){ mark(m); setFromUTC(todayUTC + 2*86400000); haveDate = true; }
  if(!haveDate){
    m = s.match(/\btomorrow\b|\btmrw\b|\btmr\b/);
    if(m){ mark(m); setFromUTC(todayUTC + 86400000); haveDate = true; }
  }
  if(!haveDate){
    m = s.match(/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening|night)\b/);
    if(m){ mark(m); setFromUTC(todayUTC); haveDate = true; }
  }
  if(!haveDate){
    m = s.match(/\bnext week\b/);
    if(m){ mark(m); setFromUTC(todayUTC + 7*86400000); haveDate = true; }
  }
  if(!haveDate){
    m = s.match(/\b(?:(next|this|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)\b/);
    if(m){
      mark(m);
      const w = m[2];
      const target = WEEKDAYS.indexOf(w) >= 0 ? WEEKDAYS.indexOf(w) : WD_SHORT[w];
      const cur = new Date(todayUTC).getUTCDay();
      let delta = (target - cur + 7) % 7;
      if(delta === 0) delta = 7;
      setFromUTC(todayUTC + delta*86400000);
      haveDate = true;
      if(draft.repeat === 'weekly') draft.anchorDay = null;
    }
  }
  if(!haveDate){
    m = s.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if(m){
      mark(m);
      const dd = parseInt(m[1],10), mo = parseInt(m[2],10) - 1;
      let yy = m[3] ? parseInt(m[3],10) : nowWall.y;
      if(yy < 100) yy += 2000;
      if(!validDate(yy, mo, dd)){
        draft.errors.push('"' + m[0].trim() + '" is not a real date (day/month order is D/M).');
      } else {
        draft.y = yy; draft.mo = mo; draft.d = dd; haveDate = true;
      }
    }
  }
  if(!haveDate && !draft.errors.length){
    m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/)
     || s.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    if(m){
      mark(m);
      let dd, mon;
      if(/^\d/.test(m[1])){ dd = parseInt(m[1],10); mon = m[2]; }
      else { mon = m[1]; dd = parseInt(m[2],10); }
      const mi2 = MONTHS.indexOf(mon) >= 0 ? MONTHS.indexOf(mon) : MON_SHORT[mon];
      let yr = nowWall.y;
      if(!validDate(yr, mi2, dd)){
        draft.errors.push(dd + ' ' + mon + ' is not a real date.');
      } else {
        if(Date.UTC(yr, mi2, dd) < todayUTC) yr += 1;
        if(!validDate(yr, mi2, dd)) yr += 1;           // 29 Feb -> next leap year
        if(!validDate(yr, mi2, dd)) draft.errors.push(dd + ' ' + mon + ' is not a real date.');
        else { draft.y = yr; draft.mo = mi2; draft.d = dd; haveDate = true; }
      }
    }
  }
  if(!haveDate && !draft.errors.length){
    m = s.match(/\b(?:on\s+the\s+|on\s+)(\d{1,2})(?:st|nd|rd|th)\b/) || s.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if(m){
      mark(m);
      const dd = parseInt(m[1],10);
      if(dd < 1 || dd > 31){
        draft.errors.push('There is no ' + dd + 'th of a month.');
      } else {
        let y = nowWall.y, mo = nowWall.mo;
        if(Date.UTC(y, mo, dd) < todayUTC || !validDate(y, mo, dd)){
          mo += 1; if(mo > 11){ mo = 0; y += 1; }
        }
        let g = 0;
        while(!validDate(y, mo, dd) && g++ < 13){ mo += 1; if(mo > 11){ mo = 0; y += 1; } }
        if(!validDate(y, mo, dd)) draft.errors.push('There is no ' + dd + 'th of a month.');
        else { draft.y = y; draft.mo = mo; draft.d = dd; haveDate = true; draft.anchorDay = dd; }
      }
    }
  }

  /* ---- time ---- */
  let haveTime = false;
  m = s.match(/\b(?:at\s+)?(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\b/);
  if(m){
    mark(m);
    let hh = parseInt(m[1],10); const mi3 = parseInt(m[2],10);
    const ap = (m[3]||'').replace(/\./g,'');
    if(ap === 'pm' && hh < 12) hh += 12;
    if(ap === 'am' && hh === 12) hh = 0;
    if(!validTime(hh, mi3)) draft.errors.push(m[0].trim() + ' is not a valid time.');
    else {
      draft.hh = hh; draft.mi = mi3; haveTime = true;
      /* "half past four" and "nine thirty" carry no am/pm. Spoken aloud these
         are as ambiguous as "at 5", so offer both rather than assume. */
      if(!ap && hh >= 1 && hh <= 12){
        const am = (hh === 12 ? 0 : hh), pm = (hh === 12 ? 12 : hh + 12);
        draft.hh = (hh >= 1 && hh <= 6) ? pm : (hh === 12 ? 12 : am);
        draft.ambiguousTime = true;
        draft.ambiguousOptions = [
          {hh:am, mi:mi3, label:pad2(am) + ':' + pad2(mi3)},
          {hh:pm, mi:mi3, label:pad2(pm) + ':' + pad2(mi3)}
        ];
      }
    }
  }
  if(!haveTime && !draft.errors.length){
    m = s.match(/\b(\d{3,4})\s*(?:hrs|hours|h)\b/);
    if(m){
      mark(m);
      const v = m[1].padStart(4,'0');
      const hh = parseInt(v.slice(0,2),10), mi4 = parseInt(v.slice(2),10);
      if(!validTime(hh, mi4)) draft.errors.push(m[1] + ' hrs is not a valid time.');
      else { draft.hh = hh; draft.mi = mi4; haveTime = true; }
    }
  }
  if(!haveTime && !draft.errors.length){
    m = s.match(/\b(?:at\s+)?(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/);
    if(m){
      mark(m);
      let hh = parseInt(m[1],10);
      const ap = (m[2]||'').replace(/\./g,'');
      if(hh < 1 || hh > 12) draft.errors.push(m[0].trim() + ' is not a valid time.');
      else {
        if(ap === 'pm' && hh < 12) hh += 12;
        if(ap === 'am' && hh === 12) hh = 0;
        draft.hh = hh; draft.mi = 0; haveTime = true;
      }
    }
  }
  if(!haveTime && !draft.errors.length){
    /* A bare hour is genuinely ambiguous — "at 5" could be either. Offer both. */
    m = s.match(/\bat\s+(\d{1,2})\b/);
    if(m){
      mark(m);
      const h = parseInt(m[1],10);
      if(h > 23){ draft.errors.push('"at ' + h + '" is not a valid time.'); }
      else if(h >= 13){ draft.hh = h; draft.mi = 0; haveTime = true; }
      else {
        draft.hh = (h >= 1 && h <= 6) ? h + 12 : (h === 12 ? 12 : h);
        draft.mi = 0; haveTime = true;
        draft.ambiguousTime = true;
        const am = (h === 12 ? 0 : h), pm = (h === 12 ? 12 : h + 12);
        draft.ambiguousOptions = [
          {hh:am, mi:0, label:pad2(am) + ':00'},
          {hh:pm, mi:0, label:pad2(pm) + ':00'}
        ];
      }
    }
  }
  if(!haveTime && !draft.errors.length){
    m = s.match(/\bnoon\b|\bmidday\b/);
    if(m){ mark(m); draft.hh = 12; draft.mi = 0; haveTime = true; }
  }
  if(!haveTime && !draft.errors.length){
    m = s.match(/\bmidnight\b/);
    if(m){
      mark(m); draft.hh = 0; draft.mi = 0; haveTime = true;
      if(!haveDate){ setFromUTC(todayUTC + 86400000); haveDate = true; }
    }
  }
  if(!haveTime && !draft.errors.length){
    m = s.match(/\b(morning|afternoon|evening|night|tonight|eod|end of day|first thing|lunch|lunchtime)\b/);
    if(m){
      mark(m);
      const w = m[1];
      draft.hh = (w === 'morning' || w === 'first thing') ? 9
               : w === 'afternoon' ? 14
               : (w === 'lunch' || w === 'lunchtime') ? 12
               : (w === 'eod' || w === 'end of day') ? 17
               : 19;
      draft.mi = 0; haveTime = true; draft.assumedTime = true;
    }
  }

  draft.title = cleanTitle(text, cuts);

  if(draft.errors.length) return draft;

  if(!haveTime && !haveDate){ draft.noTime = true; return draft; }

  if(!haveTime){ draft.hh = 9; draft.mi = 0; draft.assumedTime = true; }
  if(!haveDate){
    /* Time only: assume today, roll to tomorrow if already past. Always flagged. */
    draft.y = nowWall.y; draft.mo = nowWall.mo; draft.d = nowWall.d;
    draft.assumedDate = true;
    const candidate = wallToEpoch(draft.tz, draft.y, draft.mo, draft.d, draft.hh, draft.mi);
    if(candidate <= now.getTime()){
      const t = new Date(Date.UTC(draft.y, draft.mo, draft.d) + 86400000);
      draft.y = t.getUTCFullYear(); draft.mo = t.getUTCMonth(); draft.d = t.getUTCDate();
    }
  }
  if(draft.repeat === 'monthly' && !draft.anchorDay) draft.anchorDay = draft.d;
  return draft;
}

function pad2(n){ return String(n).padStart(2,'0'); }

function cleanTitle(raw, cuts){
  let s = String(raw);
  if(cuts && cuts.length){
    const chars = (' ' + s + ' ').split('');
    cuts.forEach(([a,b]) => { for(let i=a;i<b && i<chars.length;i++) chars[i] = '\u0000'; });
    s = chars.join('');
    s = s.replace(/\b(on|at|by|in|for|before|after|around|from|until|till|this|next|coming|starting|due)\s*\u0000+/gi,'\u0000');
    s = s.replace(/\u0000+/g,' ').trim();
  }
  s = s.replace(/^\s*(hey |ok |okay )?(watchkeeper|claude)[,\s]+/i,'');
  s = s.replace(/^\s*(please\s+)?(can you\s+)?(set (up )?(a |an )?)?(remind me to|remind me|reminder to|reminder for|reminder|remember to|note to|add (a )?(task|reminder) to|add (a )?(task|reminder)|i need to|don'?t let me forget to|make sure (i|we) )\s*/i,'');
  s = s.replace(/^\s*(that|about|for|to|on|at|a|an)\s+/i,'');
  s = s.replace(/\s{2,}/g,' ').replace(/\s+([.,!?])/g,'$1').trim();
  s = s.replace(/[.\s]+$/,'');
  let prev;
  do { prev = s; s = s.replace(/\s+(on|at|by|in|for|before|after|around|from|until|till|this|next|with|to|the|a|an|and)[.\s]*$/i,''); } while(s !== prev);
  if(!s) s = 'Reminder';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------------------------------------------------------- records --- */

function draftToItem(draft, existing){
  const it = existing ? Object.assign({}, existing) : {
    id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    created: Date.now()
  };
  it.title = draft.title || 'Reminder';
  it.heard = draft.heard || it.heard || '';
  it.kind = draft.kind || 'task';
  it.tz = draft.tz || 'local';
  it.repeat = draft.repeat || '';
  it.notes = draft.notes || '';
  it.vessel = draft.vessel || '';
  it.ref = draft.ref || '';
  it.priority = draft.priority || 'normal';
  it.durationMin = Number.isFinite(draft.durationMin) && draft.durationMin > 0
    ? Math.min(1440, Math.round(draft.durationMin)) : 30;
  it.done = existing ? !!existing.done : false;

  if(draft.noTime || draft.y == null || draft.hh == null){
    it.due = null; it.anchorDue = null; it.anchorDay = null;
  } else {
    const ms = wallToEpoch(it.tz, draft.y, draft.mo, draft.d, draft.hh, draft.mi);
    it.due = ms;
    it.anchorDue = ms;
    it.anchorDay = it.repeat === 'monthly' ? (draft.anchorDay || draft.d) : null;
  }
  it.firedAt = null;          // cleared whenever the time moves
  it.snoozed = false;
  return it;
}

function itemToDraft(it){
  const w = it.due != null ? epochToWall(it.tz || 'local', it.anchorDue != null ? it.anchorDue : it.due) : null;
  return {
    title: it.title, heard: it.heard || '', kind: it.kind,
    y: w ? w.y : null, mo: w ? w.mo : null, d: w ? w.d : null,
    hh: w ? w.hh : null, mi: w ? w.mi : 0,
    tz: it.tz || 'local', repeat: it.repeat || '', anchorDay: it.anchorDay || null,
    notes: it.notes || '', vessel: it.vessel || '', ref: it.ref || '', priority: it.priority || 'normal',
    durationMin: it.durationMin || 30,
    assumedDate:false, assumedTime:false, ambiguousTime:false, ambiguousOptions:null,
    errors:[], noTime: it.due == null
  };
}

/* ---------------------------------------------------------- migration --- */

const STORE_KEY = 'watchkeeper.v2';
const LEGACY_KEY = 'watchkeeper.v1';

function migrate(raw){
  if(!Array.isArray(raw)) return [];
  return raw.map(o => {
    if(!o || typeof o !== 'object') return null;
    const it = {
      id: o.id || ('r' + Math.random().toString(36).slice(2,10)),
      title: typeof o.title === 'string' ? o.title : 'Reminder',
      heard: typeof o.heard === 'string' ? o.heard : '',
      kind: KIND_LABEL[o.kind] ? o.kind : 'task',
      due: Number.isFinite(o.due) ? o.due : null,
      anchorDue: Number.isFinite(o.anchorDue) ? o.anchorDue : (Number.isFinite(o.due) ? o.due : null),
      anchorDay: Number.isFinite(o.anchorDay) ? o.anchorDay : null,
      tz: typeof o.tz === 'string' ? o.tz : 'local',
      repeat: ['daily','weekly','monthly','weekdays'].indexOf(o.repeat) >= 0 ? o.repeat : '',
      done: !!o.done,
      notes: typeof o.notes === 'string' ? o.notes : '',
      vessel: typeof o.vessel === 'string' ? o.vessel : '',
      ref: typeof o.ref === 'string' ? o.ref : '',
      priority: (o.priority === 'high' || o.priority === 'low') ? o.priority : 'normal',
      durationMin: (Number.isFinite(o.durationMin) && o.durationMin > 0) ? o.durationMin : 30,
      firedAt: Number.isFinite(o.firedAt) ? o.firedAt : (o.notified ? (o.due || Date.now()) : null),
      snoozed: !!o.snoozed,
      created: Number.isFinite(o.created) ? o.created : Date.now()
    };
    if(it.repeat === 'monthly' && it.anchorDay == null && it.anchorDue != null){
      it.anchorDay = epochToWall(it.tz, it.anchorDue).d;
    }
    return it;
  }).filter(Boolean);
}

function validateBackup(obj){
  const errs = [];
  if(!obj || typeof obj !== 'object') return {ok:false, errors:['File is not a Watchkeeper backup.'], items:[]};
  const arr = Array.isArray(obj) ? obj : obj.items;
  if(!Array.isArray(arr)) return {ok:false, errors:['No reminder list found in that file.'], items:[]};
  const items = migrate(arr);
  if(!items.length) errs.push('The backup contained no readable reminders.');
  items.forEach((i, n) => {
    if(i.due != null && !Number.isFinite(i.due)) errs.push('Reminder ' + (n+1) + ' has an unreadable time.');
  });
  return {ok: errs.length === 0, errors: errs, items};
}

/* ---------------------------------------------------------- scheduling --- */

/* Single gate for "should this ring right now?". Both the timer and the
   catch-up sweep call it, so a reminder can never be announced twice, and a
   timer that outlived its reminder (completed, deleted, snoozed, edited)
   finds nothing to fire. */
function shouldFire(items, id, now){
  const it = items.find(x => x.id === id);
  if(!it) return null;                       // deleted
  if(it.done) return null;                   // completed
  if(it.due == null) return null;            // time removed
  if(it.due > now) return null;              // moved later (snooze or edit)
  if(it.firedAt != null) return null;        // already announced
  return it;
}

/* Every mutation goes through here, so there is exactly one place that
   decides what happens to the series and to the fired flag. */
function applyAction(items, id, action, opts){
  opts = opts || {};
  const now = opts.now == null ? Date.now() : opts.now;
  const it = items.find(x => x.id === id);
  if(!it) return {items, changed:false, reason:'missing'};

  if(action === 'complete'){
    if(it.repeat && it.anchorDue != null){
      const nxt = nextOccurrence(it.anchorDue, it.repeat, it.tz, Math.max(now, it.anchorDue), it.anchorDay);
      it.anchorDue = nxt;
      it.due = nxt;
      it.firedAt = null;
      it.snoozed = false;
      it.done = false;
      return {items, changed:true, reason:'rescheduled', due:nxt};
    }
    it.done = true;
    it.firedAt = it.firedAt || now;
    return {items, changed:true, reason:'completed'};
  }

  if(action === 'uncomplete'){
    it.done = false;
    it.firedAt = (it.due != null && it.due <= now) ? now : null;
    return {items, changed:true, reason:'reopened'};
  }

  if(action === 'snooze'){
    const mins = opts.minutes || 10;
    it.due = now + mins * 60000;
    it.firedAt = null;
    it.snoozed = true;
    it.done = false;
    // anchorDue deliberately untouched: the series keeps its original time
    return {items, changed:true, reason:'snoozed', due:it.due};
  }

  if(action === 'delete'){
    const idx = items.findIndex(x => x.id === id);
    const removed = items[idx];
    items.splice(idx, 1);
    return {items, changed:true, reason:'deleted', removed, index:idx};
  }

  return {items, changed:false, reason:'unknown-action'};
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {TZ_CHOICES, REPEATS, KIND_LABEL, deviceTz, tzOffsetMs, wallToEpoch, epochToWall,
    tzLabel, daysInMonth, validDate, validTime, nextOccurrence, parseDraft, cleanTitle,
    draftToItem, itemToDraft, migrate, validateBackup, detectKind, pad2, STORE_KEY, LEGACY_KEY,
    shouldFire, applyAction, isoWithOffset, teamsMeetingUrl};
}
