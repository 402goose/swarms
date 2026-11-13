// Browser regression probe: starter kit + Sanctuary feedback + firing/raise controls + facing tour.
// Requires: `pnpm dev` running (web :15173, server :18787) and Google Chrome installed.
// Run: node tests/browser/face-click-probe.mjs — exits non-zero on assertion failure.
// Facing is screenshot-verified (saves /tmp/face-click-*.png); assertions cover the rest.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/Users/alectaggart/CascadeProjects/swarms/package.json");
const WebSocket = require("ws");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9251;
const profile = "/tmp/swarms-face-click-profile";
fs.rmSync(profile, { recursive: true, force: true });
const proc = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profile}`, "--window-size=1440,950", "--no-first-run",
  "--disable-default-apps", "--disable-frame-rate-limit", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "http://127.0.0.1:15173/",
], { stdio: ["ignore", "pipe", "pipe"] });
let seq = 0; const pending = new Map(); const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function send(ws, method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)); }, 20_000);
  });
}
async function waitVersion() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); }
    catch { await sleep(250); }
  } throw new Error("CDP no start");
}
const T0 = Date.now();
const log = (...a) => console.log(`[+${Math.round((Date.now() - T0) / 1000)}s]`, ...a);
try {
  const version = await waitVersion();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page" && t.url.includes("15173"));
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) { const c = pending.get(msg.id); pending.delete(msg.id); msg.error ? c.reject(new Error(JSON.stringify(msg.error))) : c.resolve(msg.result); }
    if (msg.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(msg.params).slice(0, 300));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") errors.push(JSON.stringify(msg.params).slice(0, 300));
  });
  const sid = (await send(ws, "Target.attachToTarget", { targetId: page.id, flatten: true })).sessionId;
  await send(ws, "Page.enable", {}, sid); await send(ws, "Runtime.enable", {}, sid);
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false }, sid);
  await send(ws, "Page.addScriptToEvaluateOnNewDocument", { source: [
    "window.__self=null;window.__fired=0;window.__seen={};window.__pstart={};window.__maxBolt=0;window.__pickups=0;window.__deaths=0;window.__alive=true;window.__near=null;window.__kills=0;window.__hhp={};window.__dmg=0;window.__frames=0;window.__fps=0;",
    "(()=>{let last=performance.now(),n=0;const f=(t)=>{n++;window.__frames++;if(t-last>=1000){window.__fps=Math.round(n*1000/(t-last));n=0;last=t;}requestAnimationFrame(f);};requestAnimationFrame(f);})();",
    "const NWS=window.WebSocket;",
    "window.WebSocket=function(...a){const s=new NWS(...a);s.addEventListener('message',(e)=>{try{const m=JSON.parse(String(e.data));if(m.type!=='snapshot')return;const sn=m.snapshot;const sc=(sn.commanders||[]).find(c=>c.id===sn.selfCommanderId);",
    "window.__pickups=(sn.pickups||[]).length;for(const p of (sn.projectiles||[]).filter(p=>p.ownerId===sn.selfCommanderId)){const k=String(p.id??(p.x+','+p.y+','+sn.tick));const st=window.__pstart[k]||(window.__pstart[k]={x:p.x,y:p.y});if(p.weapon==='bolt')window.__maxBolt=Math.max(window.__maxBolt,Math.hypot(p.x-st.x,p.y-st.y));if(!window.__seen[k]){window.__seen[k]=1;window.__fired++;}}",
    "const host=(sn.entities||[]).filter(en=>en.kind==='monster');const newh={};for(const h of host){newh[h.id]=h.hp;const prev=window.__hhp[h.id];if(prev!=null&&h.hp<prev)window.__dmg+=prev-h.hp;}for(const id in window.__hhp){if(!(id in newh)&&window.__hhp[id]<=25)window.__kills++;}window.__hhp=newh;",
    "window.__rooms=sn.world?sn.world.rooms:(window.__rooms||null);window.__ts=sn.world?sn.world.tileSize:(window.__ts||32);const mine=(sn.entities||[]).filter(en=>en.kind==='unit'&&en.ownerId===sn.selfCommanderId);",
    "if(sc){let nd=1e9,nn=null;for(const h of host){const d=Math.hypot(h.x-sc.x,h.y-sc.y);if(d<nd){nd=d;nn=h;}}window.__near=nn?{kind:nn.kind,dist:Math.round(nd),dx:Math.round(nn.x-sc.x),dy:Math.round(nn.y-sc.y),hp:nn.hp}:null;",
    "if(window.__alive&&!sc.alive)window.__deaths++;window.__alive=sc.alive;window.__self={x:Math.round(sc.x),y:Math.round(sc.y),hp:sc.hp,maxHp:sc.maxHp,lv:sc.level,xp:sc.xp,xpNext:sc.xpNext,alive:sc.alive,character:sc.character,weapon:sc.weapon,weapons:sc.weapons,units:sc.unitCount,minions:mine.length,ess:sc.essence,cmd:sc.command,stance:sc.stance,sparks:sn.wallet?sn.wallet.sparks:null,hostiles:host.length,ents:(sn.entities||[]).length,tick:sn.tick};}}catch{}});return s;};",
    "window.WebSocket.prototype=NWS.prototype;Object.assign(window.WebSocket,NWS);",
  ].join("\n") }, sid);
  await send(ws, "Page.reload", {}, sid);
  await sleep(3000);
  const ev = async (expr) => { const r = await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result?.value; };
  const shot = async (f) => { const r = await send(ws, "Page.captureScreenshot", { format: "png" }, sid); fs.writeFileSync(f, Buffer.from(r.data, "base64")); log("shot", f); };
  const mouse = (type, x, y, button, buttons) => send(ws, "Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: 1 }, sid);
  const key = (type, k, code, vk) => send(ws, "Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
  const tap = async (k, code, vk) => { await key("keyDown", k, code, vk); await sleep(80); await key("keyUp", k, code, vk); };
  const KM = { w: ["w", "KeyW", 87], a: ["a", "KeyA", 65], s: ["s", "KeyS", 83], d: ["d", "KeyD", 68] };
  const pressed = new Set();
  const setKeys = async (want) => { for (const k of Object.keys(KM)) { if (want.includes(k) && !pressed.has(k)) { await key("keyDown", ...KM[k]); pressed.add(k); } if (!want.includes(k) && pressed.has(k)) { await key("keyUp", ...KM[k]); pressed.delete(k); } } };
  const self = () => ev("window.__self").catch(() => null);
  const tele = async () => ev("({fired:window.__fired,maxBolt:Math.round(window.__maxBolt),pickups:window.__pickups,kills:window.__kills,dmg:Math.round(window.__dmg),deaths:window.__deaths,fps:window.__fps,near:window.__near})").catch(() => ({}));
  const stateLine = async (tag) => { log(tag, JSON.stringify(await self()), JSON.stringify(await tele())); };

  let cardBox = null;
  for (let i = 0; i < 40 && !cardBox; i++) {
    cardBox = await ev("(()=>{const c=document.querySelector('#char-cards > *');if(!c)return null;const r=c.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()").catch(() => null);
    if (!cardBox) await sleep(500);
  }
  if (!cardBox) { console.log("ASSERT FAIL: character cards never appeared"); process.exit(1); }
  await mouse("mousePressed", cardBox.x, cardBox.y, "left", 1); await mouse("mouseReleased", cardBox.x, cardBox.y, "left", 0); await sleep(300);
  let enterBox = null;
  for (let i = 0; i < 20 && !enterBox; i++) {
    enterBox = await ev("(()=>{const b=document.querySelector('#char-enter');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()").catch(() => null);
    if (!enterBox) await sleep(250);
  }
  if (!enterBox) { console.log("ASSERT FAIL: Enter button never appeared"); process.exit(1); }
  await mouse("mousePressed", enterBox.x, enterBox.y, "left", 1); await mouse("mouseReleased", enterBox.x, enterBox.y, "left", 0);
  let joined = false; for (let i = 0; i < 25 && !joined; i++) { await sleep(400); joined = Boolean(await self()); }
  log("joined:", joined, JSON.stringify(await self()));
  const joinedSelf = await self();
  if (!joined || joinedSelf?.character !== "necromancer" || joinedSelf?.weapon !== "wisp" || !joinedSelf?.weapons?.includes("bolt") || joinedSelf?.minions !== 18) {
    console.log("ASSERT FAIL: Necromancer starter kit/cap not visible", JSON.stringify(joinedSelf));
    process.exit(1);
  }
  log("starter kit:", JSON.stringify({ weapon: joinedSelf.weapon, weapons: joinedSelf.weapons, minions: joinedSelf.minions }), JSON.stringify(await tele()));
  await shot("/tmp/face-click-spawn.png");
  // ASSERT 1: holding LMB in the Sanctuary must explain itself, not silently no-op
  await mouse("mousePressed", 1000, 450, "left", 1); await sleep(900);
  const sealed = await ev("document.querySelector('#status')?.textContent");
  await mouse("mouseReleased", 1000, 450, "left", 0);
  log("sanctuary click status:", JSON.stringify(sealed));
  if (!String(sealed).includes("sealed in the Sanctuary")) { console.log("ASSERT FAIL: no sealed feedback in Sanctuary"); process.exit(1); }
  await tap("Tab", "Tab", 9);
  await sleep(700);
  const afterTab = await self();
  log("after Tab weapon:", afterTab?.weapon);
  if (afterTab?.weapon !== "bolt") { console.log("ASSERT FAIL: Tab did not switch Wisp -> Bolt"); process.exit(1); }
  log("post-join active:", JSON.stringify(await ev("document.activeElement?.tagName + '#' + (document.activeElement?.id||'') + ' hidden=' + document.querySelector('#char-select')?.hidden")), "hasFocus:", JSON.stringify(await ev("document.hasFocus()")));
  for (let i = 0; i < 8; i++) {
    await key("keyUp", "d", "KeyD", 68); await key("keyDown", "d", "KeyD", 68);
    await sleep(600);
    const m = await self();
    log("freshD", i, "x:", m?.x, "active:", JSON.stringify(await ev("document.activeElement?.tagName + '#' + (document.activeElement?.id||'')")));
    if (m && m.x > 470) break;
  }
  await key("keyUp", "d", "KeyD", 68); await sleep(300);
  log("outside:", JSON.stringify(await self()));
  const beforeRaise = await self();
  await tap("g", "KeyG", 71);
  await sleep(800);
  const afterRaise = await self();
  const raiseStatus = await ev("document.querySelector('#status')?.textContent");
  log("raise G:", JSON.stringify({ xBefore: beforeRaise?.x, yBefore: beforeRaise?.y, xAfter: afterRaise?.x, yAfter: afterRaise?.y, before: beforeRaise?.minions, after: afterRaise?.minions, essenceBefore: beforeRaise?.ess, essenceAfter: afterRaise?.ess, status: raiseStatus }));
  const raiseObserved = afterRaise?.minions > beforeRaise?.minions || ["Swarm at cap", "Not enough essence"].includes(String(raiseStatus));
  if (!raiseObserved) { console.log("ASSERT FAIL: G raise caused no unit or actionable status"); process.exit(1); }
  await mouse("mouseMoved", 1350, 460, "none", 0);
  await mouse("mousePressed", 1350, 460, "right", 2); await mouse("mouseReleased", 1350, 460, "right", 0);
  await sleep(700);
  const afterRmb = await self();
  log("after RMB:", JSON.stringify({ stance: afterRmb?.stance, x: afterRmb?.x, y: afterRmb?.y }));
  if (afterRmb?.stance !== "attack") { console.log("ASSERT FAIL: RMB did not set attack stance"); process.exit(1); }
  const qBefore = await self();
  await tap("q", "KeyQ", 81);
  await sleep(800);
  const qAfter = await self();
  const novaLabel = await ev("document.querySelector('#spell-nova-label')?.textContent");
  log("Grave Nova:", JSON.stringify({ cmdBefore: qBefore?.cmd, cmdAfter: qAfter?.cmd, label: novaLabel, x: qAfter?.x, y: qAfter?.y }));
  if (!String(novaLabel).includes("Grave Nova") || !(qAfter?.cmd < qBefore?.cmd)) { console.log("ASSERT FAIL: Grave Nova did not cast"); process.exit(1); }
  for (let i = 0; i < 8; i++) {
    const m = await self();
    if (m && m.x > 620) break;
    await key("keyUp", "d", "KeyD", 68); await key("keyDown", "d", "KeyD", 68);
    await sleep(600);
  }
  await key("keyUp", "d", "KeyD", 68); await sleep(200);
  const firingPosition = await self();
  log("firing position:", JSON.stringify(firingPosition));
  if (!firingPosition || firingPosition.x <= 384) { console.log("ASSERT FAIL: commander not outside Sanctuary for firing test"); process.exit(1); }
  const f0 = (await tele()).fired ?? 0;
  await mouse("mousePressed", 1050, 470, "left", 1); await sleep(120); await mouse("mouseReleased", 1050, 470, "left", 0);
  await sleep(1200);
  const afterTap = ((await tele()).fired ?? 0) - f0;
  await mouse("mousePressed", 1050, 460, "left", 1); await sleep(900); await mouse("mouseReleased", 1050, 460, "left", 0); await sleep(800);
  const afterHold = ((await tele()).fired ?? 0) - f0;
  log("TAP fired:", afterTap, " TAP+HOLD fired:", afterHold, " status:", JSON.stringify(await ev("document.querySelector('#status')?.textContent")));
  if (!(afterTap >= 1 && afterHold >= 3)) { console.log("ASSERT FAIL: tap/hold did not fire outside"); process.exit(1); }
  await shot("/tmp/face-click-outside.png");
  const finalTele = await tele();
  log("range/pickups:", JSON.stringify({ maxBolt: finalTele.maxBolt, pickups: finalTele.pickups, fps: finalTele.fps }));
  if (finalTele.pickups > 371) { console.log("ASSERT FAIL: live pickup count exceeds caps + relic"); process.exit(1); }
  const frames0 = await ev("window.__frames");
  await sleep(3000);
  const frames1 = await ev("window.__frames");
  log("clean FPS:", Math.round((frames1 - frames0) / 3));
  log("ASSERT PASS: starter kit + sealed feedback + Tab/RMB/Q/G/LMB controls");
  const full = async (f) => { const r = await send(ws, "Page.captureScreenshot", { format: "png" }, sid); fs.writeFileSync(f, Buffer.from(r.data, "base64")); };
  const dirs = [["d", "east"], ["a", "west"], ["w", "north"], ["s", "south"]];
  for (const [k, name] of dirs) { await key("keyDown", k, "Key" + k.toUpperCase(), k.toUpperCase().charCodeAt(0)); await sleep(1500); await full(`/tmp/face-click-${name}.png`); await key("keyUp", k, "Key" + k.toUpperCase(), k.toUpperCase().charCodeAt(0)); await sleep(250); }
  log("facing tour screenshots saved to /tmp/face-click-{east,west,north,south}.png (verify: east/west = side view, north = back, south = front)");
  ws.close();
} finally { proc.kill("SIGTERM"); }
