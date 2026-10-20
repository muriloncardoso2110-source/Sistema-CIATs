import { createPublicKey, verify, randomBytes, createHash } from 'node:crypto';
import { config } from './config.mjs';
import { db, one, stmt, run, uid, audit } from './db.mjs';

const cached = new Map();
async function request(url, options={}, limitMs=12000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(limitMs) });
  const raw = await response.text();
  let body; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {error:raw.slice(0,400)}; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error_description || body.error?.message || body.error || 'Requisição rejeitada'}`);
  return body;
}
function ensureConfig(...values) { if (values.some(x=>!x)) throw new Error('Configure as credenciais Microsoft no arquivo .env'); }
async function tokenFor(tenant, clientId, secret, scope) {
  const key = `${tenant}:${clientId}:${scope}`;
  const hit = cached.get(key); if (hit && hit.exp > Date.now()) return hit.value;
  const body = await request(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method:'POST', headers: {'content-type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id:clientId,client_secret:secret,grant_type:'client_credentials',scope}).toString()
  });
  cached.set(key,{value:body.access_token,exp:Date.now()+(Number(body.expires_in)||3600)*1000-180000});
  return body.access_token;
}
export async function syncEntraUsers(actorId) {
  ensureConfig(config.tenant,config.clientId,config.clientSecret);
  const token = await tokenFor(config.tenant,config.clientId,config.clientSecret,'https://graph.microsoft.com/.default');
  const select = 'id,displayName,mail,userPrincipalName,accountEnabled,department,jobTitle,officeLocation';
  let next = `https://graph.microsoft.com/v1.0/users?$select=${select}&$top=999`;
  const results = []; let pages=0;
  while(next) {
    if (++pages > 100) throw new Error('O número de páginas excedeu o limite de segurança');
    const u = new URL(next);
    if (u.protocol !== 'https:' || u.hostname !== 'graph.microsoft.com') throw new Error('URL de paginação Graph inválida');
    const result = await request(next,{headers:{Authorization:`Bearer ${token}`}});
    results.push(...(result.value||[])); next=result['@odata.nextLink']||null;
  }
  const up = db.prepare(`INSERT INTO users(id,azure_oid,name,email,username,department,branch,title,active,source)
    VALUES(?,?,?,?,?,?,?,?,?,'entra')
    ON CONFLICT(email) DO UPDATE SET azure_oid=excluded.azure_oid,name=excluded.name,
     username=excluded.username,department=excluded.department,branch=excluded.branch,
     title=excluded.title,active=excluded.active,source='entra',updated_at=datetime('now')`);
  const getByAzure = db.prepare('SELECT * FROM users WHERE azure_oid=?');
  let inserted=0,disabled=0; const seen=new Set();
  db.exec('BEGIN');
  try {
    for (const r of results) {
      const email = String(r.mail || r.userPrincipalName || '').trim().toLowerCase();
      if (!email || !r.id || !email.includes('@')) continue;
      const prior = getByAzure.get(r.id);
      if (prior && prior.email !== email) run('UPDATE users SET email=? WHERE id=?',email,prior.id);
      up.run(prior?.id || uid(),r.id,r.displayName||email,email,r.userPrincipalName||email,r.department||'',r.officeLocation||'',r.jobTitle||'',r.accountEnabled===false?0:1);
      if (r.accountEnabled===false) disabled++;
      inserted++; seen.add(r.id);
    }
    // A listagem completa é necessária antes de considerar contas removidas do diretório.
    for (const u of stmt("SELECT id,azure_oid FROM users WHERE source='entra' AND azure_oid IS NOT NULL")) {
      if (!seen.has(u.azure_oid)) run('UPDATE users SET active=0,updated_at=datetime(\'now\') WHERE id=?',u.id);
    }
    audit(actorId,'entra.sync','users',inserted,`Importados: ${inserted}; desabilitados Graph: ${disabled}`);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return {total:inserted,disabled,pages};
}
export const oauthReady = () => Boolean(config.tenant && config.clientId && config.clientSecret);
export function createOauthChallenge() {
  const state=randomBytes(24).toString('base64url'); const verifier=randomBytes(48).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const redirect = `${config.baseUrl}/api/auth/microsoft/callback`;
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize`);
  url.search=new URLSearchParams({client_id:config.clientId,response_type:'code',redirect_uri:redirect,response_mode:'query',scope:'openid profile email User.Read',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
  return {state,verifier,url:url.toString()};
}
export async function redeemOauth(code,verifier) {
  ensureConfig(config.tenant,config.clientId,config.clientSecret);
  const token = await request(`https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`,{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
      client_id:config.clientId,client_secret:config.clientSecret,code,code_verifier:verifier,
      grant_type:'authorization_code',redirect_uri:`${config.baseUrl}/api/auth/microsoft/callback`,scope:'openid profile email User.Read'
    }).toString()
  });
  const me=await request('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,department,jobTitle,officeLocation',{
    headers:{Authorization:`Bearer ${token.access_token}`}
  });
  if (!me?.id) throw new Error('Não foi possível validar usuário no Microsoft Graph');
  const email=String(me.mail||me.userPrincipalName||'').toLowerCase();
  let existing=one('SELECT * FROM users WHERE azure_oid=?',me.id) || one('SELECT * FROM users WHERE email=?',email);
  if(existing?.active===0) throw new Error('A conta está desativada no diretório da plataforma');
  if(existing) {
    run("UPDATE users SET azure_oid=?,name=?,username=?,updated_at=datetime('now') WHERE id=?",me.id,me.displayName||existing.name,me.userPrincipalName||email,existing.id);
    return one('SELECT * FROM users WHERE id=?',existing.id);
  }
  const id=uid();
  run("INSERT INTO users(id,azure_oid,name,email,username,department,branch,title,source) VALUES(?,?,?,?,?,?,?,?,'entra')",
    id,me.id,me.displayName||email,email,me.userPrincipalName||email,me.department||'',me.officeLocation||'',me.jobTitle||'');
  return one('SELECT * FROM users WHERE id=?',id);
}

let signingCache = {expiry:0,keys:[]};
const jwtParse=(chunk)=>JSON.parse(Buffer.from(chunk,'base64url').toString('utf8'));
export async function verifyBotJwt(authHeader, activity) {
  ensureConfig(config.botId,config.botPassword,config.botTenant);
  const token = String(authHeader||'').match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if(!token) throw new Error('Cabeçalho de autenticação do bot ausente');
  const parts=token.split('.'); if(parts.length!==3) throw new Error('JWT inválido');
  const h=jwtParse(parts[0]); const p=jwtParse(parts[1]);
  if(h.alg!=='RS256' || !h.kid) throw new Error('Algoritmo JWT não aceito');
  const t=Math.floor(Date.now()/1000);
  if(p.iss!=='https://api.botframework.com' || p.aud!==config.botId || !p.exp || p.exp<=t-60 || p.nbf>t+60)
    throw new Error('Emissor, audiência ou validade do JWT inválidos');
  if(p.serviceurl && p.serviceurl.replace(/\/$/,'') !== String(activity.serviceUrl||'').replace(/\/$/,''))
    throw new Error('serviceUrl não corresponde ao JWT');
  if(Date.now()>signingCache.expiry) {
    const meta=await request('https://login.botframework.com/v1/.well-known/openidconfiguration');
    const u=new URL(meta.jwks_uri);
    if(u.protocol!=='https:' || !['login.botframework.com','login.microsoftonline.com'].includes(u.hostname)) throw new Error('Host das chaves inválido');
    const jwks=await request(meta.jwks_uri);
    signingCache={keys:jwks.keys||[],expiry:Date.now()+3600000};
  }
  const jwk=signingCache.keys.find(k=>k.kid===h.kid && k.kty==='RSA');
  if(!jwk || !verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))
    throw new Error('Assinatura JWT inválida');
  if(activity.channelId!=='msteams') throw new Error('Canal não permitido');
  const tenant=activity.channelData?.tenant?.id || activity.conversation?.tenantId;
  if(tenant !== config.botTenant) throw new Error('Tenant Teams diferente do configurado');
  if(!activity.from?.aadObjectId) throw new Error('Atividade Teams sem identidade Entra');
  return p;
}
function trustedService(url) {
  try { const u=new URL(url); return u.protocol==='https:' && /(^|\.)(trafficmanager\.net|teams\.microsoft\.com|skype\.com)$/.test(u.hostname) && !u.username && !u.password; }
  catch { return false; }
}
async function botToken() {
  ensureConfig(config.botId,config.botPassword,config.botTenant);
  return tokenFor(config.botTenant,config.botId,config.botPassword,'https://api.botframework.com/.default');
}
async function postToConnector({service_url,conversation_id,bot_id,teams_user_id},text) {
  if(!trustedService(service_url)) throw new Error('serviceUrl Teams não confiável');
  const token=await botToken();
  const url=`${service_url.replace(/\/$/,'')}/v3/conversations/${encodeURIComponent(conversation_id)}/activities`;
  return request(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({
    type:'message',from:{id:bot_id},recipient:{id:teams_user_id},conversation:{id:conversation_id},text,
    textFormat:'plain',channelId:'msteams'
  })});
}
export async function replyTeamsForTicket(ticket,text) {
  const connection=one('SELECT c.* FROM teams_connections c JOIN users u ON u.azure_oid=c.azure_oid WHERE u.id=?',ticket.requester_id);
  if(!connection) return {status:'nao_conectado'};
  try { await postToConnector(connection,`💬 Suporte Solvia · Chamado #${ticket.id}\n\n${text}\n\nResponda aqui para continuar o atendimento.`); return {status:'enviado'}; }
  catch(e) { console.error('Falha Teams:',e.message); return {status:'falhou',error:e.message}; }
}
export async function receiveTeamsMessage(activity) {
  if(!['message','conversationUpdate'].includes(activity.type)) return {ignored:true};
  if(activity.conversation?.conversationType && activity.conversation.conversationType!=='personal') return {ignored:true};
  const azure=activity.from.aadObjectId;
  let user=one('SELECT * FROM users WHERE azure_oid=?',azure);
  if (!user) {
    // O tenant e a origem já foram conferidos pelo validador de JWT.
    const mail=`${azure.toLowerCase()}@teams.solvia.local`;
    const id=uid();
    run("INSERT INTO users(id,azure_oid,name,email,source) VALUES(?,?,?,?,'teams')",id,azure,activity.from.name||'Usuário Teams',mail);
    user=one('SELECT * FROM users WHERE id=?',id);
  }
  if (!user.active) return {ignored:true,reason:'disabled'};
  if(!trustedService(activity.serviceUrl)) throw new Error('serviceUrl não confiável');
  run(`INSERT INTO teams_connections(azure_oid,user_id,conversation_id,service_url,bot_id,teams_user_id,tenant_id)
       VALUES(?,?,?,?,?,?,?) ON CONFLICT(azure_oid) DO UPDATE SET user_id=excluded.user_id,
       conversation_id=excluded.conversation_id,service_url=excluded.service_url,bot_id=excluded.bot_id,
       teams_user_id=excluded.teams_user_id,updated_at=datetime('now')`,
       azure,user.id,activity.conversation.id,activity.serviceUrl,activity.recipient?.id||config.botId,activity.from.id,config.botTenant);
  if(activity.type!=='message' || !activity.text?.trim()) return {ignored:true,connected:true};
  // Teams pode reenviar webhooks em caso de timeout; a chave externa protege contra duplicação.
  if(activity.id && one('SELECT id FROM ticket_messages WHERE external_id=?',activity.id)) return {duplicate:true};
  const text=String(activity.text).replace(/<[^>]*>/g,'').trim().slice(0,3500);
  const connected=one('SELECT * FROM teams_connections WHERE azure_oid=?',azure);
  const match=text.match(/^#(\d+)\s+([\s\S]*)$/);
  const incoming=match ? match[2].trim() : text;
  if(/^\/?(ajuda|help)$/i.test(incoming)) {
    await postToConnector(connected,'Olá! Sou a central Solvia. Escreva *novo: descrição do problema* para abrir um chamado, ou responda aqui para atualizar o último chamado em andamento. Para direcionar uma mensagem a um chamado, digite #1042 sua mensagem.');
    return {help:true};
  }
  const explicitlyNew=/^(novo|abrir|novo chamado)\s*[:\-]\s*/i.test(incoming);
  let ticket=null;
  if(match) ticket=one('SELECT * FROM tickets WHERE id=? AND requester_id=?',Number(match[1]),user.id);
  else if(!explicitlyNew) ticket=one("SELECT * FROM tickets WHERE requester_id=? AND status NOT IN ('encerrado','resolvido') ORDER BY id DESC LIMIT 1",user.id);
  if(match && !ticket) {
    await postToConnector(connected,'Este chamado não foi encontrado na sua conta. Confira o número ou escreva *novo: descrição do problema*.');
    return {notFound:true};
  }
  const message=explicitlyNew ? incoming.replace(/^(novo|abrir|novo chamado)\s*[:\-]\s*/i,'').trim() : incoming;
  if(!message) { await postToConnector(connected,'Descreva o problema após *novo:*.');return {empty:true}; }
  let isNew=false;
  if(!ticket) {
    const title=message.replace(/\s+/g,' ').slice(0,95);
    const r=run("INSERT INTO tickets(requester_id,title,description,category,team,priority,source,due_at) VALUES(?,?,?,'Geral','Service Desk','media','teams',datetime('now','+24 hours'))",user.id,title,message);
    ticket=one('SELECT * FROM tickets WHERE id=?',Number(r.lastInsertRowid));
    isNew=true;
  }
  // A coluna external_id impede duplicação por webhook repetido.
  if(activity.id && one('SELECT id FROM ticket_messages WHERE external_id=?',activity.id)) return {duplicate:true};
  run('INSERT INTO ticket_messages(ticket_id,author_id,author_name,body,channel,external_id) VALUES(?,?,?,?,?,?)',ticket.id,user.id,user.name,message,'teams',activity.id||null);
  run("UPDATE tickets SET updated_at=datetime('now') WHERE id=?",ticket.id);
  if(isNew) await postToConnector(connected,`✅ Chamado #${ticket.id} aberto!\n\n${ticket.title}\n\nA equipe de suporte poderá responder diretamente por este chat. Para abrir outro chamado, envie *novo: descrição*.`);
  else await postToConnector(connected,`✅ Sua mensagem foi adicionada ao chamado #${ticket.id}.`);
  return {ticketId:ticket.id,created:isNew};
}
export const integrationHealth=()=>({
  entra:oauthReady() ? 'configurado' : 'pendente',
  teams:config.botId && config.botPassword && config.botTenant ? 'configurado':'pendente',
  demo:config.demo
});
