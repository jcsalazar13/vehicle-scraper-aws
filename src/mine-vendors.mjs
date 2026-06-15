import fs from 'node:fs';
import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const urls=fs.readFileSync('urls.custom.txt','utf8').split('\n').filter(Boolean);
const tally={};
const browser=await chromium.launch({headless:true});
async function one(u){
  let ctx;
  try{
    ctx=await browser.newContext({userAgent:UA});
    const page=await ctx.newPage();
    await page.goto(u,{waitUntil:'commit',timeout:18000});
    await page.waitForTimeout(2500);
    const doms=await page.evaluate(()=>{
      const s=new Set();
      for(const el of document.querySelectorAll('[src],[href]')){const v=el.getAttribute('src')||el.getAttribute('href')||'';const m=v.match(/^https?:\/\/([a-z0-9.-]+)/i);if(m){const p=m[1].toLowerCase().split('.');s.add(p.slice(-2).join('.'));}}
      const gen=document.querySelector('meta[name="generator"]')?.content||'';
      return {doms:[...s],gen};
    });
    for(let d of doms.doms){if(/google|gstatic|jquery|cloudflare|cloudfront|fonts|facebook|gtag|youtube|bootstrapcdn|jsdelivr|gravatar|w3\.org|googleapis|cdnjs|recaptcha|doubleclick|googletag|fbcdn|instagram|twitter|linkedin|bing|googleadservices|ampproject|gstatic|tiktok|pinterest|hotjar|cargurus|kbb\.com|carfax|autocheck/i.test(d))continue;tally[d]=(tally[d]||0)+1;}
    if(doms.gen){const g='gen:'+doms.gen.split(/[\s\d]/)[0];tally[g]=(tally[g]||0)+1;}
  }catch{}finally{await ctx?.close().catch(()=>{});}
}
let i=0;await Promise.all(Array.from({length:6},async()=>{while(i<urls.length){await one(urls[i++]);}}));
const sorted=Object.entries(tally).sort((a,b)=>b[1]-a[1]);
fs.writeFileSync('vendor-tally.txt',sorted.map(([d,n])=>`${n}\t${d}`).join('\n'));
console.log('=== TOP VENDORS EN BUCKET CUSTOM ('+urls.length+' sitios) ===');
for(const [d,n] of sorted.slice(0,40))console.log(String(n).padStart(3),d);
await browser.close();
