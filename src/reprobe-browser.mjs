import fs from 'node:fs';
import { chromium } from 'playwright';
import { isBlocked } from './fetch/managed-fetch.js';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const urls=fs.readFileSync('urls.reprobe.txt','utf8').split('\n').filter(Boolean);
const browser=await chromium.launch({headless:true});
const out=[];
async function one(u){
  let ctx;
  try{
    ctx=await browser.newContext({userAgent:UA});
    const page=await ctx.newPage();
    let status=0;
    try{const r=await page.goto(u,{waitUntil:'commit',timeout:22000});status=r?.status()??0;}catch{}
    await page.waitForTimeout(2500);
    let html=''; try{html=await page.content();}catch{}
    if(isBlocked(html,status)){out.push([u,'antibot_real']);return;}
    // ¿hay señal de vehículos tras render? (VIN, data-vin, JSON-LD)
    const hasVeh=/\b[A-HJ-NPR-Z0-9]{17}\b/.test(html)||/data-vin|"vin"|vehicleIdentificationNumber|dws-vehicle|ds-vehicle|dealr-inventory|srp-card/i.test(html);
    out.push([u, hasVeh?'L3_navegacion':'L3_sin_senal']);
  }catch{out.push([u,'antibot_real']);}finally{await ctx?.close().catch(()=>{});}
}
let i=0;await Promise.all(Array.from({length:6},async()=>{while(i<urls.length){await one(urls[i++]);}}));
const dist={};for(const [,l] of out)dist[l]=(dist[l]||0)+1;
console.log('=== RE-PROBE CON NAVEGADOR ('+out.length+') ===');
for(const [k,v] of Object.entries(dist).sort((a,b)=>b[1]-a[1]))console.log(String(v).padStart(4),k);
fs.writeFileSync('reprobe-map.csv','url,layer2\n'+out.map(r=>r.join(',')).join('\n')+'\n');
await browser.close();
