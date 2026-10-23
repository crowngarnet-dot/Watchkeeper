/* ============================================================
   Watchkeeper voice layer.

   Speech in, speech out, and the small grammar that connects them.
   Kept apart from the app so the command parsing can be tested without
   a microphone.
   ============================================================ */

/* ---------------------------------------------------------- grammar --- */

/* Spoken replies are messy: recognisers drop words, add filler, and hear
   "done" as "down". Each matcher is deliberately loose. */

const YES = /\b(yes|yeah|yep|yup|ok|okay|correct|right|confirm|confirmed|save|saved|save it|do it|go ahead|sure|affirmative|fine|good|perfect|that'?s right)\b/i;
const NO  = /\b(no|nope|cancel|discard|forget it|never mind|nevermind|stop|wrong|not right|delete it|scrap it)\b/i;
const REPEAT_ASK = /\b(repeat|again|say again|pardon|what|come again|read it back)\b/i;
const DONE_CMD = /\b(done|did it|finished|complete|completed|dismiss|clear|close|mark done|down)\b/i;
const SNOOZE_CMD = /\b(snooze|later|remind me later|wait|postpone|delay|not now|hold)\b/i;
/* A spoken duration on its own is a snooze: "in an hour", "two hours". */
const DURATION = /\b(?:in\s+)?(?:a|an|\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty[\s-]?five|sixty|half)\s*(?:minutes?|mins?|hours?|hrs?|days?)\b/i;
const MORNING = /\b(morning|a\s?\.?\s?m\s?\.?)\b/i;
const EVENING = /\b(evening|afternoon|night|p\s?\.?\s?m\s?\.?)\b/i;

/* "snooze thirty minutes", "in an hour", "tomorrow" */
function snoozeMinutes(text){
  const s = String(text).toLowerCase();
  if(/\btomorrow\b/.test(s)) return 1440;
  if(/\bnext week\b/.test(s)) return 10080;
  const words = {a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    fifteen:15,twenty:20,thirty:30,forty:40,'forty-five':45,'forty five':45,sixty:60,half:30,'a half':30};
  const m = s.match(/(\d{1,4}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty five|forty-five|sixty|half)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)/);
  if(m){
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1],10) : (words[m[1]] || 1);
    const u = m[2];
    if(u.startsWith('min')) return n;
    if(u.startsWith('h')) return n * 60;
    if(u.startsWith('d')) return n * 1440;
  }
  if(/\bhalf an hour\b/.test(s)) return 30;
  if(/\ban hour\b/.test(s)) return 60;
  return 10;                                   // bare "snooze"
}

/* What the user said in reply to a read-back. */
function parseConfirmReply(text){
  const s = String(text || '').trim();
  if(!s) return {type:'none'};
  if(REPEAT_ASK.test(s) && s.split(/\s+/).length <= 4) return {type:'repeat'};
  /* A correction usually carries a new time or date, so check that before
     a bare yes/no — "no, make it eleven" is a correction, not a refusal. */
  const hasChange = /\b(change|make it|instead|move|actually|not|rather|should be|set it)\b/i.test(s)
                 || /\b(\d{1,2})([:.]\d{2})?\s*(am|pm)?\b/.test(s)
                 || /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|morning|afternoon|evening|noon|midnight)\b/i.test(s);
  if(hasChange && !(YES.test(s) && s.split(/\s+/).length <= 3)) return {type:'change', text:s};
  if(YES.test(s)) return {type:'yes'};
  if(NO.test(s)) return {type:'no'};
  return {type:'unclear', text:s};
}

/* What the user said while an alarm was ringing. */
function parseAlarmReply(text){
  const s = String(text || '').trim();
  if(!s) return {type:'none'};
  if(SNOOZE_CMD.test(s)) return {type:'snooze', minutes: snoozeMinutes(s)};
  /* "remind me in an hour", "give me two hours", "tomorrow" */
  if(DURATION.test(s) || /\btomorrow\b/i.test(s)) return {type:'snooze', minutes: snoozeMinutes(s)};
  if(DONE_CMD.test(s) || YES.test(s)) return {type:'done'};
  if(NO.test(s)) return {type:'snooze', minutes:10};
  return {type:'unclear', text:s};
}

/* Which reading of an ambiguous hour the user picked. */
function parseAmPmReply(text){
  const s = String(text || '');
  if(EVENING.test(s)) return 'pm';
  if(MORNING.test(s)) return 'am';
  return null;
}

/* Spoken commands that are not reminders. */
function parseCommand(text){
  const s = String(text || '').toLowerCase().trim();
  if(!s) return {type:'none'};
  if(/\b(what'?s|whats|what is)\s+(next|coming up)\b/.test(s) || /\bnext reminder\b/.test(s)) return {type:'next'};
  if(/\b(what'?s|whats|what is|read|list|tell me)\b.*\b(today|today'?s)\b/.test(s)) return {type:'today'};
  if(/\b(read|list|tell me|what are)\b.*\b(reminders?|everything|all)\b/.test(s)) return {type:'list'};
  if(/\b(undo|put it back|restore)\b/.test(s)) return {type:'undo'};
  if(/\b(help|what can you do|commands)\b/.test(s)) return {type:'help'};
  if(/\b(stop|quiet|silence|shut up)\b/.test(s) && s.split(/\s+/).length <= 3) return {type:'stop'};
  return {type:'reminder', text:s};
}

/* ---------------------------------------------------------- speaking --- */

function makeSpeaker(){
  const synth = (typeof window !== 'undefined') ? window.speechSynthesis : null;
  let voice = null;

  function pickVoice(preferred){
    if(!synth) return null;
    const all = synth.getVoices() || [];
    if(!all.length) return null;
    const want = (preferred || 'en-GB').toLowerCase();
    return all.find(v => v.lang && v.lang.toLowerCase() === want)
        || all.find(v => v.lang && v.lang.toLowerCase().startsWith(want.slice(0,2)))
        || all[0];
  }
  if(synth){
    const refresh = () => { voice = pickVoice(); };
    refresh();
    if(typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refresh);
  }

  return {
    supported: !!synth,
    setLang(l){ voice = pickVoice(l); },
    cancel(){ try{ if(synth) synth.cancel(); }catch(e){} },
    /* Resolves when the phrase has finished, so the recogniser is never
       started while the device is still talking to itself. */
    say(text, opts){
      opts = opts || {};
      return new Promise(resolve => {
        if(!synth || !text){ resolve(false); return; }
        try{ synth.cancel(); }catch(e){}
        const u = new SpeechSynthesisUtterance(String(text));
        if(voice) u.voice = voice;
        u.rate = opts.rate || 1.02;
        u.pitch = opts.pitch || 1;
        u.volume = opts.volume == null ? 1 : opts.volume;
        let settled = false;
        const finish = () => { if(!settled){ settled = true; resolve(true); } };
        u.onend = finish;
        u.onerror = finish;
        /* Some Android builds never fire onend; cap the wait by length. */
        setTimeout(finish, Math.min(20000, 1600 + String(text).length * 75));
        try{ synth.speak(u); }catch(e){ finish(); }
      });
    }
  };
}

/* ---------------------------------------------------------- phrasing --- */

const SPOKEN_KIND = {meeting:'Meeting', followup:'Follow up', call:'Call', task:'Task'};
const SPOKEN_REPEAT = {daily:'every day', weekly:'every week', monthly:'every month', weekdays:'every weekday'};

function spokenTime(hh, mi){
  if(hh == null) return '';
  const ap = hh < 12 ? 'A M' : 'P M';
  let h = hh % 12; if(h === 0) h = 12;
  if(mi === 0) return h + ' ' + ap;
  if(mi < 10) return h + ' oh ' + mi + ' ' + ap;
  return h + ' ' + mi + ' ' + ap;
}
function spokenDay(y, mo, d, now){
  const target = Date.UTC(y, mo, d);
  const n = now || new Date();
  const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  const diff = Math.round((target - today) / 86400000);
  if(diff === 0) return 'today';
  if(diff === 1) return 'tomorrow';
  if(diff === -1) return 'yesterday';
  const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August',
                  'September','October','November','December'];
  if(diff > 1 && diff < 7) return 'on ' + names[new Date(target).getUTCDay()];
  return 'on the ' + ordinal(d) + ' of ' + months[mo];
}
function ordinal(n){
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* The sentence read back before anything is saved. */
function draftSentence(draft, now){
  const bits = [];
  bits.push(SPOKEN_KIND[draft.kind] || 'Task');
  bits.push(draft.title + '.');
  if(draft.noTime || draft.y == null){
    bits.push('No time was heard.');
  } else {
    bits.push(spokenDay(draft.y, draft.mo, draft.d, now) + ' at ' + spokenTime(draft.hh, draft.mi) + '.');
  }
  if(draft.repeat) bits.push('Repeating ' + (SPOKEN_REPEAT[draft.repeat] || draft.repeat) + '.');
  if(draft.tz && draft.tz !== 'local') bits.push(draft.tz.split('/').pop().replace('_',' ') + ' time.');
  return bits.join(' ');
}

function confirmPrompt(draft){
  if(draft.errors && draft.errors.length) return draft.errors[0] + ' Say the date and time again.';
  if(draft.ambiguousTime) return 'Was that morning or evening?';
  if(draft.noTime) return 'Say a time, or say save to keep it with no alarm.';
  return 'Save it?';
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {parseConfirmReply, parseAlarmReply, parseAmPmReply, parseCommand,
    snoozeMinutes, makeSpeaker, draftSentence, confirmPrompt, spokenTime, spokenDay, ordinal,
    SPOKEN_KIND, SPOKEN_REPEAT};
}
