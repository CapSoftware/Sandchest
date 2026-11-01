/**
 * The browser's error reporter: one small inline script, rendered only when
 * NEXT_PUBLIC_SENTRY_DSN is set. Pages without it carry no Sentry bytes at
 * all. It listens for uncaught errors and unhandled rejections, builds the
 * same allowlisted event as the server (see `sentry.ts`: messages withheld
 * unless known safe, then scrubbed) and sends it with `fetch(keepalive)`: at
 * most ten per page, each distinct error once. Nothing runs until an error
 * happens, so it costs no time on the critical path.
 */
import { MAX_MESSAGE, parseDsn, SAFE_MESSAGES, SCRUB_RULES, WITHHELD } from "./sentry";

/**
 * The reporter's code. Injected as JSON: `C` the configuration, `S` the
 * scrub rules, `P` the safe message shapes, `M` the message limit and `W`
 * the placeholder for a withheld message.
 */
const REPORTER = `
function re(l){var o=[];l.forEach(function(s){try{o.push([new RegExp(s[0],s[1]),s[2]])}catch(e){}});return o}
var R=re(S),Q=re(P);
function scrub(t){t=(typeof t=="string"?t:String(t==null?"":t)).slice(0,M*4);R.forEach(function(r){t=t.replace(r[0],r[1])});return t.length>M?t.slice(0,M)+"\\u2026":t}
function msg(m){m=(typeof m=="string"?m:"").slice(0,M*4);for(var i=0;i<Q.length;i++){var x=Q[i][0].exec(m);if(x)return scrub(x[0])}return W}
var O=location.origin,sent=0,seen={};
function file(f){f=f.split(/[?#]/)[0];return f.indexOf(O)==0?"app://"+f.slice(O.length):scrub(f)}
function frames(st){var out=[];String(st||"").split("\\n",60).forEach(function(l){if(l.length>1000)return;var m=/^\\s*at (?:async )?(?:(.+?) \\()?(.+?):(\\d+):(\\d+)\\)?\\s*$/.exec(l)||/^\\s*(.*?)@(.+?):(\\d+):(\\d+)\\s*$/.exec(l);if(!m)return;var f=file(m[2]),fr={filename:f,lineno:+m[3],colno:+m[4],in_app:f.indexOf("app://")==0};if(m[1])fr["function"]=m[1].slice(0,200);out.push(fr)});return out.reverse()}
function values(err,mech){var v=[],c=err;for(var d=0;d<3&&c!=null;d++){if(c instanceof Error){var f=frames(c.stack),x={type:scrub(c.name||"Error").slice(0,100),value:msg(c.message),mechanism:mech};if(f.length)x.stacktrace={frames:f};v.push(x);c=c.cause}else{v.push({type:"NonError",value:"Non-error value thrown: "+typeof c,mechanism:mech});break}}return v.reverse()}
function page(){return location.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,"[id]").replace(/\\/\\d{3,}(?=\\/|$)/g,"/[id]").slice(0,200)}
function report(err,type){try{if(sent>=10)return;var v=values(err,{type:type,handled:false});var l=v[v.length-1]||{},t=l.stacktrace?l.stacktrace.frames[l.stacktrace.frames.length-1]:{};var k=l.type+":"+String(l.value).slice(0,120)+":"+t.filename+":"+t.lineno;if(seen[k])return;seen[k]=1;sent++;
var id=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now()).replace(/-/g,"");
var ev={event_id:id,timestamp:Date.now()/1000,platform:"javascript",level:"error",exception:{values:v},tags:{source:"browser",page:page()},sdk:{name:"sandchest.sentry",version:"1"}};if(C.e)ev.environment=C.e;if(C.r)ev.release=C.r;
fetch(C.u,{method:"POST",body:JSON.stringify({event_id:id,sent_at:new Date().toISOString(),dsn:C.d})+"\\n"+JSON.stringify({type:"event"})+"\\n"+JSON.stringify(ev)+"\\n",keepalive:true,credentials:"omit",headers:{"content-type":"text/plain;charset=UTF-8"}}).catch(function(){})}catch(e){}}
addEventListener("error",function(e){if(!e.error&&/^Script error\\.?$/.test(e.message||""))return;report(e.error||new Error(e.message),"onerror")});
addEventListener("unhandledrejection",function(e){report(e.reason,"onunhandledrejection")});`;

/** JSON safe to place inside a <script>: no "</script>", no HTML comment openers. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * The inline script for the browser, or undefined when no public DSN is set
 * (or it is not a valid DSN): then nothing is rendered.
 */
export function browserReporter(env: { dsn?: string; environment?: string; release?: string }): string | undefined {
  const target = parseDsn(env.dsn);
  if (!target) return undefined;
  const config = { u: target.endpoint, d: target.dsn, e: env.environment?.slice(0, 64), r: env.release?.slice(0, 12) };
  return `(function(){var C=${inlineJson(config)},S=${inlineJson(SCRUB_RULES)},P=${inlineJson(SAFE_MESSAGES)},M=${MAX_MESSAGE},W=${inlineJson(WITHHELD)};${REPORTER.trim()}})();`;
}
