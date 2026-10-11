'use strict';
// Native account management: no shell, Python, uv, or external account manager.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');
const lockfile = require('proper-lockfile');
const VAULT = 'claudeIsland.accounts.v1';
const URLS = Object.freeze({profile:'https://api.anthropic.com/api/oauth/profile',usage:'https://api.anthropic.com/api/oauth/usage',token:'https://platform.claude.com/v1/oauth/token'});
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const same = (a,b) => a?.accountUuid && a.accountUuid === b?.accountUuid && (a.organizationUuid || '') === (b.organizationUuid || '');
const clone = value => JSON.parse(JSON.stringify(value));
function percent(n) { return typeof n === 'number' && Number.isFinite(n) ? Math.max(0,Math.min(100,n)) : undefined; }
function windowData(w) { return w && typeof w === 'object' ? {pct:percent(w.utilization),resetsAt:typeof w.resets_at === 'string' ? w.resets_at : undefined} : undefined; }
function request(kind, token, body) {
  if (!Object.hasOwn(URLS,kind)) return Promise.reject(new Error('Unsupported service request.'));
  return new Promise((resolve,reject)=>{
    const bytes = body ? JSON.stringify(body) : undefined;
    const headers = {'User-Agent':'Claude-Island/0.2.0','Accept':'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (kind === 'usage') headers['anthropic-beta'] = 'oauth-2025-04-20';
    if (bytes) {headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(bytes);}
    const req = https.request(URLS[kind],{method:bytes?'POST':'GET',headers},res=>{
      let data='';
      res.on('error',()=>reject(new Error('Anthropic response was interrupted. Try again.')));
      res.on('data',chunk=>{data+=chunk;if(data.length>1024*1024)req.destroy(new Error('Response too large'));});
      res.on('end',()=>{
        if(res.statusCode<200 || res.statusCode>=300){const e=new Error(res.statusCode===401||res.statusCode===400?'Claude login expired. Sign in again in Claude Code, then save the login.':`Anthropic ${kind} request returned HTTP ${res.statusCode}.`);e.status=res.statusCode;return reject(e);}
        try{resolve(JSON.parse(data));}catch{reject(new Error('Anthropic returned an unreadable response.'));}
      });
    });
    const timer=setTimeout(()=>req.destroy(new Error('Request timeout')),12000);
    req.on('close',()=>clearTimeout(timer));
    req.on('error',()=>reject(new Error('Could not reach Anthropic. Check your connection and try again.')));
    req.end(bytes);
  });
}
async function atomicWrite(file,text) {
  const temp = `${file}.island-${crypto.randomUUID()}.tmp`;let handle;
  try {
    handle=await fs.open(temp,'wx',0o600);await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=undefined;
    for(let attempt=0;;attempt++) {try{await fs.rename(temp,file);break;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt===4)throw e;await new Promise(r=>setTimeout(r,50*(attempt+1)));}}
  } finally {await handle?.close();await fs.unlink(temp).catch(()=>{});}
}
class AccountManager {
  constructor(secrets, options={}) {
    this.secrets=secrets;this.home=options.home||os.homedir();this.env=options.env||process.env;this.platform=options.platform||process.platform;
    this.dir=options.dir||this.env.CLAUDE_CONFIG_DIR||path.join(this.home,'.claude');
    this.config=options.config||path.join(this.env.CLAUDE_CONFIG_DIR||this.home,'.claude.json');
    this.credentials=path.join(this.dir,'.credentials.json');this.api=options.request||request;
    this.write=options.write||atomicWrite;this.now=options.now||Date.now;this.cache=new Map();this.pending=Promise.resolve();
  }
  async exclusive(fn) {
    const previous=this.pending;let done;this.pending=new Promise(r=>{done=r;});await previous;
    const releases=[];let compromised=false;
    const acquire=async(p,stale=60000)=>{const unlock=await lockfile.lock(p,{lockfilePath:p,realpath:false,stale,update:5000,retries:{retries:8,factor:1,minTimeout:250,maxTimeout:250},onCompromised:()=>{compromised=true;}});let released=false;const release=async()=>{if(!released){released=true;await unlock();}};releases.push(release);return release;};
    try {
      if(this.platform==='darwin')throw new Error('This version supports Claude file-based logins on Windows and Linux. macOS Keychain support is not implemented.');
      await fs.mkdir(this.dir,{recursive:true});await acquire(path.join(this.dir,'.island-native.lock'));
      const guard=()=>{if(compromised)throw new Error('Account files changed concurrently. Retry after Claude finishes signing in.');};
      return await fn({guard,acquire});
    }catch(e){if(e.code==='ELOCKED')throw new Error('Claude is updating account files. Wait a moment and retry.');throw e;}
    finally{for(const release of releases.reverse())await release().catch(()=>{});done();}
  }
  async vault() {
    const raw=await this.secrets.get(VAULT);if(!raw)return {version:1,accounts:[],lastSwitch:0};
    let data;try{data=JSON.parse(raw);}catch{throw new Error('Saved account storage could not be read. It has not been overwritten.');}
    if(data.version!==1||!Array.isArray(data.accounts))throw new Error('Unsupported saved account storage version.');return data;
  }
  async store(v) {await this.secrets.store(VAULT,JSON.stringify(v));}
  async readJson(file) {
    let text;try{text=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return undefined;throw new Error(`Could not read Claude ${path.basename(file)}.`);}
    try{const data=JSON.parse(text);if(!data||Array.isArray(data)||typeof data!=='object')throw Error();return {text,data};}catch{throw new Error(`Claude ${path.basename(file)} is invalid JSON. No changes were made.`);}
  }
  async live() {
    const legacy=path.join(this.dir,'.config.json');if(await fs.stat(legacy).then(()=>true,()=>false))this.config=legacy;
    const cred=await this.readJson(this.credentials), config=await this.readJson(this.config);
    return {cred,config,identity:config?.data.oauthAccount,oauth:cred?.data.claudeAiOauth};
  }
  validate(live) {
    if(!live.oauth?.accessToken || !live.identity?.accountUuid || !live.identity?.emailAddress)throw new Error('Sign in to Claude Code first, then select Save current login.');
    if(live.config.data.primaryApiKey || this.env.ANTHROPIC_API_KEY || this.env.CLAUDE_CODE_OAUTH_TOKEN || this.env.ANTHROPIC_AUTH_TOKEN)throw new Error('An API key or environment token overrides the Claude login. Native switching supports Claude subscription logins only.');
  }
  async verify(oauth,identity) {
    const profile=await this.api('profile',oauth.accessToken);
    if(profile.account?.uuid!==identity.accountUuid || (identity.organizationUuid && profile.organization?.uuid!==identity.organizationUuid))throw new Error('Login identity does not match its saved account. Sign in again and save the login.');
  }
  capture(v,live,create=false) {
    if(!live.oauth?.accessToken||!live.identity?.accountUuid)return undefined;
    let a=v.accounts.find(a=>same(a.identity,live.identity));
    if(!a&&create){a={number:Math.max(0,...v.accounts.map(a=>a.number))+1,disabled:false};v.accounts.push(a);}
    if(a){a.identity=clone(live.identity);a.oauth=clone(live.oauth);a.organizationUuid=live.cred.data.organizationUuid;}return a;
  }
  async credentialLocks(acquire) {await acquire(path.join(this.dir,'.oauth_refresh.lock'));await acquire(`${this.dir}.lock`);}
  async recover(v, guard) {
    if(!v.recovery)return;const r=v.recovery;
    if(r.credentialsPath!==this.credentials||r.configPath!==this.config)throw new Error('An unfinished account switch belongs to another Claude profile. Open that profile to recover it.');
    const c=await fs.readFile(this.credentials,'utf8'), f=await fs.readFile(this.config,'utf8');
    if(hash(c)===r.afterCred && hash(f)===r.afterConfig){v.lastSwitch=this.now();delete v.recovery;await this.store(v);return;}
    if(![r.beforeCredHash,r.afterCred].includes(hash(c))||![r.beforeConfigHash,r.afterConfig].includes(hash(f)))throw new Error('Claude changed files during an interrupted switch. Recovery is preserved in encrypted storage; no files were overwritten.');
    guard();await this.write(this.credentials,r.beforeCred);guard();await this.write(this.config,r.beforeConfig);delete v.recovery;await this.store(v);
  }
  async saveCurrent() {
    return this.exclusive(async({guard,acquire})=>{
      let live=await this.live();this.validate(live);await this.credentialLocks(acquire);await acquire(`${this.config}.lock`,10000);
      const v=await this.vault();await this.recover(v,guard);live=await this.live();this.validate(live);await this.verify(live.oauth,live.identity);guard();
      const after=await this.live();if(after.cred.text!==live.cred.text||after.config.text!==live.config.text)throw new Error('Claude login changed while saving. Please try again.');
      const a=this.capture(v,live,true);await this.store(v);return a.number;
    });
  }
  async list() {
    return this.exclusive(async({guard,acquire})=>{
      const v=await this.vault();await this.live();
      const primary=await acquire(path.join(this.dir,'.oauth_refresh.lock'));
      const legacy=await acquire(`${this.dir}.lock`);
      const configLock=await acquire(`${this.config}.lock`,10000);
      await this.recover(v,guard);let live=await this.live();
      // Capture the first account from Claude itself, never another tool's backups.
      if(!v.accounts.length && live.oauth?.accessToken && live.identity?.accountUuid){
        this.validate(live);await this.verify(live.oauth,live.identity);
        const current=await this.live();if(current.cred.text!==live.cred.text||current.config.text!==live.config.text)throw new Error('Claude login changed while loading. Refresh to try again.');
        this.capture(v,live,true);await this.store(v);
      }else{
        const existing=v.accounts.find(a=>same(a.identity,live.identity));
        if(existing && live.oauth?.accessToken && existing.oauth.accessToken!==live.oauth.accessToken)await this.verify(live.oauth,live.identity);
        if(this.capture(v,live)){guard();await this.store(v);}
      }
      await configLock();await legacy();await primary();
      const rows=[];
      for(const a of v.accounts){
        const active=same(a.identity,live.identity)&&a.oauth.accessToken===live.oauth?.accessToken;
        const key=hash(a.oauth.accessToken),cached=this.cache.get(key);let usage=cached;
        if(!cached || cached.next<=this.now()){
          if(Number(a.oauth.expiresAt)<=this.now()){usage={status:'token_expired',next:this.now()+60000};}
          else try{const result=await this.api('usage',a.oauth.accessToken);usage={status:'ok',fiveHour:windowData(result.five_hour),sevenDay:windowData(result.seven_day),at:new Date(this.now()).toISOString(),next:this.now()+120000};}
          catch(e){usage={status:e.status===429?'rate_limited':e.status===401?'token_expired':'unavailable',next:this.now()+(e.status===429?300000:60000)};}
          this.cache.set(key,usage);
        }
        rows.push({number:a.number,email:a.identity.emailAddress,alias:a.alias||'',active:!!active,disabled:!!a.disabled,usageStatus:usage.status,fiveHour:usage.fiveHour,sevenDay:usage.sevenDay,fetchedAt:usage.at});
      }return rows;
    });
  }
  async setDisabled(number,disabled) {await this.exclusive(async()=>{const v=await this.vault();const a=v.accounts.find(a=>a.number===number);if(!a)throw new Error('Account not found.');a.disabled=!!disabled;await this.store(v);});}
  async switchTo(number, expectedActive) {
    if(!Number.isSafeInteger(number)||number<1)throw new Error('Invalid account.');
    return this.exclusive(async({guard,acquire})=>{
      await this.live();await this.credentialLocks(acquire);const v=await this.vault();const target=v.accounts.find(a=>a.number===number);if(!target)throw new Error('Account not found.');
      if(v.recovery){await acquire(`${this.config}.lock`,10000);await this.recover(v,guard);throw new Error('Recovered the previous interrupted switch. Please retry.');}
      const live=await this.live();this.validate(live);
      if(same(target.identity,live.identity)){this.capture(v,live);await this.store(v);return false;}
      if(expectedActive!==undefined){const current=v.accounts.find(a=>same(a.identity,live.identity));if(current?.number!==expectedActive || this.now()-(v.lastSwitch||0)<300000)return false;}
      await this.verify(live.oauth,live.identity);this.capture(v,live,true);await this.store(v);
      if(Number(target.oauth.expiresAt||0)<=this.now()+60000){
        if(!target.oauth.refreshToken)throw new Error('Saved login expired. Sign in to that account in Claude Code and save it again.');
        const response=await this.api('token',undefined,{grant_type:'refresh_token',refresh_token:target.oauth.refreshToken,client_id:'9d1c250a-e61b-44d9-88ed-5944d1962f5e'});
        if(typeof response.access_token!=='string'||!Number.isFinite(response.expires_in))throw new Error('Token refresh returned an invalid response.');
        target.oauth={...target.oauth,accessToken:response.access_token,refreshToken:response.refresh_token||target.oauth.refreshToken,expiresAt:this.now()+response.expires_in*1000};if(response.scope)target.oauth.scopes=response.scope.split(' ');
        guard();await this.store(v);
      }
      await this.verify(target.oauth,target.identity);guard();await acquire(`${this.config}.lock`,10000);
      const before=await this.live();this.validate(before);
      if(!same(before.identity,live.identity)||before.oauth.accessToken!==live.oauth.accessToken)throw new Error('Claude login changed during the switch. Retry.');
      const nextCred={...before.cred.data,claudeAiOauth:target.oauth};if(target.organizationUuid)nextCred.organizationUuid=target.organizationUuid;else delete nextCred.organizationUuid;
      const nextConfig={...before.config.data,oauthAccount:target.identity};const credText=JSON.stringify(nextCred,null,2),configText=JSON.stringify(nextConfig,null,2);
      v.recovery={credentialsPath:this.credentials,configPath:this.config,beforeCred:before.cred.text,beforeConfig:before.config.text,beforeCredHash:hash(before.cred.text),beforeConfigHash:hash(before.config.text),afterCred:hash(credText),afterConfig:hash(configText)};await this.store(v);
      try{guard();await this.write(this.credentials,credText);guard();await this.write(this.config,configText);}
      catch{await this.recover(v,guard);throw new Error('Could not complete the switch. Your previous login was restored.');}
      v.lastSwitch=this.now();delete v.recovery;await this.store(v);return true;
    });
  }
  async autoSwitch(threshold=90) {
    const rows=await this.list(),active=rows.find(a=>a.active);
    const known=a=>a.usageStatus==='ok'&&Number.isFinite(a.fiveHour?.pct)&&Number.isFinite(a.sevenDay?.pct);
    const used=a=>Math.max(a.fiveHour.pct,a.sevenDay.pct);
    if(!active||active.disabled||!known(active)||used(active)<threshold)return false;
    const target=rows.filter(a=>!a.active&&!a.disabled&&known(a)&&used(a)<threshold&&used(a)<=used(active)-5).sort((a,b)=>used(a)-used(b))[0];
    return target?this.switchTo(target.number,active.number):false;
  }
}
module.exports={AccountManager,request,percent,windowData,atomicWrite,VAULT};
