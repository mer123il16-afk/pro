const { spawn } = require('child_process');
const B='http://127.0.0.1:3100/api', GOOD='123456789:AAFakeTokenForTestingOnly_abcdefghij';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(t,m,p,b){const r=await fetch(B+p,{method:m,headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {...(await r.json().catch(()=>({}))),_s:r.status}}
const b64=s=>Buffer.from(s).toString('base64');
(async()=>{
  const T=(await api(null,'POST','/auth/register',{email:`x${Date.now()}@t.io`,name:'x',password:'password123'})).token;
  const bot=await api(T,'POST','/bots',{name:'cpu'}); await api(T,'PUT',`/bots/${bot.id}/token`,{token:GOOD});
  await api(T,'POST',`/bots/${bot.id}/main`,{name:'main.py',content_b64:b64('import os,urllib.request\nprint("busy",flush=True)\nwhile True:\n    sum(i*i for i in range(100000))\n')});
  const r=await api(T,'POST',`/bots/${bot.id}/run`); console.log('run:',JSON.stringify(r).slice(0,200));
  await api(T,'GET',`/bots/${bot.id}/stats`); await sleep(1500);
  const s=await api(T,'GET',`/bots/${bot.id}/stats`); console.log('CPU sample 2:',s.cpu,'% RAM',s.ram_mb,'MB', s.cpu>30?'PASS':'FAIL');
  // حد الذاكرة يُطبَّق في اختبار منفصل؛ هنا نختبر استعادة البوت بعد إعادة تشغيل الخادم
  console.log('bot desired=running; restarting server...');
  process.kill(Number(require('fs').readFileSync('/tmp/bf-test/server.pid','utf8')),'SIGTERM'); await sleep(1500);
  require('child_process').execSync('bash /tmp/bf-test/start.sh');
  await sleep(2500);
  const st=await api(T,'GET',`/bots/${bot.id}`); console.log('after server restart status:',st.status, st.status==='running'?'PASS':'FAIL');
  const lg=await api(T,'GET',`/bots/${bot.id}/logs`); console.log('restore logged:',lg.logs.some(l=>l.m.includes('استعادة تلقائية'))?'PASS':'FAIL');
  await api(T,'POST',`/bots/${bot.id}/stop`);
})();
