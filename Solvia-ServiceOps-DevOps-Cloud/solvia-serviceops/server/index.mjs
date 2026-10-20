import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash,timingSafeEqual,scryptSync} from 'node:crypto';
import {config} from './config.mjs';
import {db,stmt,one,run,uid,now,audit} from './db.mjs';
import {syncEntraUsers,oauthReady,createOauthChallenge,redeemOauth,verifyBotJwt,replyTeamsForTicket,receiveTeamsMessage,integrationHealth} from './integrations.mjs';
import {instrument,authorized,renderMetrics} from './metrics.mjs';

if(!config.demo && !config.baseUrl.startsWith('https://')) throw new Error('Produção requer BASE_URL com HTTPS');
if(!config.demo && !oauthReady()) throw new Error('Produção requer ENTRA_TENANT_ID, ENTRA_CLIENT_ID e ENTRA_CLIENT_SECRET configurados');
const publicDir=path.resolve('public');
const subscribers=new Set();
const expiry=60*60*12;
const statuses=['aberto','em_atendimento','pendente_usuario','resolvido','encerrado'];
const priorities=['baixa','media','alta','critica'];
const cat=['Geral','Sistemas','Equipamentos','Impressoras','Redes','Software','Acessos','Segurança','Outros'];
const teamList=['Service Desk','Infraestrutura','Aplicações','Segurança'];
const mime={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const throttle=new Map();
const sha=v=>createHash('sha256').update(v).digest('hex');
const json=(res,status,value,headers={})=>{ res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value)); };
const respondError=(res,status,message)=>json(res,status,{error:message});
function cookie(req,key) { return Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split(/=(.*)/s,2)))[key]; }
function sessionFor(req) {
  const raw=cookie(req,'solvia_session');
  if(!raw || !/^[A-Za-z0-9_-]{35,}$/.test(raw)) return null;
  const sess = one('SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1',sha(raw),Date.now());
  if(!config.demo && sess?.source==='local') return null;
  return sess;
}
function issueSession(res,user,redirect=false) {
  const raw=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');
  run('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)',sha(raw),user.id,csrf,Date.now()+expiry*1000);
  res.setHeader('set-cookie',`solvia_session=${raw}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${expiry}${config.production?'; Secure':''}`);
  return csrf;
}
function safeUser(u) { return {id:u.id,azure_oid:u.azure_oid,name:u.name,email:u.email,username:u.username,department:u.department,branch:u.branch,title:u.title,role:u.role,active:!!u.active,source:u.source}; }
function publish(event='updated') { for(const r of subscribers) {try {r.write(`event: refresh\ndata: ${JSON.stringify({event})}\n\n`);} catch {subscribers.delete(r);} } }
async function readBody(req,max=200000) {
  let content='';for await(const chunk of req) { content+=chunk.toString(); if(content.length>max) throw Object.assign(new Error('Payload excede limite'),{status:413}); }
  try {return content?JSON.parse(content):{};} catch {throw Object.assign(new Error('JSON inválido'),{status:400});}
}
const trim=(v,max=300)=>String(v??'').trim().slice(0,max);
const required=(v,name,max=300)=>{const s=trim(v,max);if(!s) throw Object.assign(new Error(`${name} é obrigatório`),{status:400});return s;};
const int=(v,d=0)=>Number.isFinite(Number(v))?Math.trunc(Number(v)):d;
const forbid=(message='Acesso não autorizado')=>{throw Object.assign(new Error(message),{status:403});};
const bad=(message)=>{throw Object.assign(new Error(message),{status:400});};
const roleAtLeast=(user,role='agent')=>{if(role==='admin'&&user.role!=='admin') forbid();if(role==='agent'&&!['admin','agent'].includes(user.role))forbid();};
function checkThrottle(ip){const t=Date.now();let e=throttle.get(ip);if(!e||t-e.at>60000) e={at:t,count:0};e.count++;throttle.set(ip,e);if(e.count>180) throw Object.assign(new Error('Muitas solicitações, tente novamente'),{status:429});if(throttle.size>2000){for(const [k,v] of throttle) if(t-v.at>120000) throttle.delete(k);}}
function checkOrigin(req){if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return;const origin=req.headers.origin;if(!origin)return;const target=new URL(config.baseUrl).origin;if(origin!==target)forbid('Origem da requisição não permitida');}
function accessibleTicket(id,user) {
  const t=one(`SELECT t.*,r.name requester_name,r.email requester_email,r.department requester_department,
      a.name assignee_name FROM tickets t JOIN users r ON r.id=t.requester_id
      LEFT JOIN users a ON a.id=t.assignee_id WHERE t.id=?`,id);
  if(!t) throw Object.assign(new Error('Chamado não encontrado'),{status:404});
  if(user.role==='requester'&&t.requester_id!==user.id)forbid();
  return t;
}
function ticketList({where='1=1',params=[],limit=50,offset=0}) {
  return stmt(`SELECT t.*,u.name requester_name,u.department requester_department,a.name assignee_name
    FROM tickets t JOIN users u ON u.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id
    WHERE ${where} ORDER BY CASE WHEN t.priority='critica' THEN 0 WHEN t.priority='alta' THEN 1 ELSE 2 END, t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`,...params,limit,offset);
}
function csvCell(v){return `"${String(v??'').replace(/"/g,'""')}"`;}

async function api(req,res,url) {
  const pathname=url.pathname;
  if(pathname==='/api/health'&&req.method==='GET') return json(res,200,{ok:true,app:'Solvia ServiceOps',version:process.env.APP_VERSION||'local',database:'sqlite',...integrationHealth()});
  if(pathname==='/api/ready'&&req.method==='GET') {
    const ready=one('SELECT 1 AS ready')?.ready===1;
    return json(res,ready?200:503,{ready});
  }
  if(pathname==='/api/teams/messages'&&req.method==='POST') {
    if(integrationHealth().teams!=='configurado') return respondError(res,503,'Bot Teams não configurado');
    const activity=await readBody(req,300000);
    await verifyBotJwt(req.headers.authorization,activity);
    const outcome=await receiveTeamsMessage(activity);
    publish('teams');return json(res,200,outcome);
  }
  if(pathname==='/api/auth/login'&&req.method==='POST') {
    if(!config.demo) return forbid('Login local desativado. Entre com sua conta Microsoft.');
    const ip=req.socket.remoteAddress||'unknown';
    const v=throttle.get(`login-${ip}`)||{at:Date.now(),count:0};
    if(Date.now()-v.at>15*60000){v.at=Date.now();v.count=0;}
    v.count++;throttle.set(`login-${ip}`,v);
    if(v.count>15) return respondError(res,429,'Muitas tentativas de login');
    const b=await readBody(req);const u=one('SELECT * FROM users WHERE lower(email)=lower(?)',trim(b.email,250));
    let valid=false;
    if(u?.password_hash) {
      const [salt,hash]=u.password_hash.split(':');
      const actual=scryptSync(String(b.password||''),salt,64);
      valid=hash?.length===128 && timingSafeEqual(Buffer.from(hash,'hex'),actual);
    }
    if(!u||!u.active||!valid) return respondError(res,401,'Credenciais incorretas ou conta inativa');
    const csrf=issueSession(res,u);audit(u.id,'auth.login','user',u.id);
    return json(res,200,{user:safeUser(u),csrf});
  }
  if(pathname==='/api/auth/microsoft'&&req.method==='GET') {
    if(!oauthReady()) return respondError(res,503,'Login Microsoft não configurado');
    const {state,verifier,url:loginUrl}=createOauthChallenge();
    const cookieFlag=`HttpOnly; SameSite=Lax; Path=/api/auth/microsoft; Max-Age=600${config.production?'; Secure':''}`;
    res.writeHead(302,{location:loginUrl,'set-cookie':[`solvia_state=${state}; ${cookieFlag}`,`solvia_verifier=${verifier}; ${cookieFlag}`]});return res.end();
  }
  if(pathname==='/api/auth/microsoft/callback'&&req.method==='GET') {
    const state=cookie(req,'solvia_state'),verifier=cookie(req,'solvia_verifier');
    if(!state||!verifier||state!==url.searchParams.get('state')||!url.searchParams.get('code'))forbid('Falha na validação de login Microsoft');
    const u=await redeemOauth(url.searchParams.get('code'),verifier);
    issueSession(res,u,true);
    res.writeHead(302,{location:'/'});return res.end();
  }
  const user=sessionFor(req);
  if(pathname==='/api/auth/me'&&req.method==='GET') return json(res,200,{user:user?safeUser(user):null,csrf:user?.csrf||null,...integrationHealth()});
  if(!user) return respondError(res,401,'Sua sessão expirou. Entre novamente.');
  if(['POST','PATCH','PUT','DELETE'].includes(req.method)&&pathname!=='/api/auth/logout'&&req.headers['x-csrf-token']!==user.csrf) forbid('Token CSRF inválido');
  if(pathname==='/api/auth/logout'&&req.method==='POST') {
    if(req.headers['x-csrf-token']!==user.csrf)forbid('CSRF');
    run('DELETE FROM sessions WHERE token_hash=?',sha(cookie(req,'solvia_session')));
    res.setHeader('set-cookie',`solvia_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax${config.production?'; Secure':''}`);
    return json(res,200,{ok:true});
  }
  if(pathname==='/api/events'&&req.method==='GET') {
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
    res.write(': conectado\n\n');subscribers.add(res);req.on('close',()=>subscribers.delete(res));return;
  }
  if(pathname==='/api/dashboard'&&req.method==='GET') {
    const mine=user.role==='requester'?'WHERE requester_id=?':'';const arg=mine?[user.id]:[];
    const counts=stmt(`SELECT status,COUNT(*) qty FROM tickets ${mine} GROUP BY status`,...arg);
    const byStatus=Object.fromEntries(statuses.map(s=>[s,counts.find(x=>x.status===s)?.qty||0]));
    const total=Object.values(byStatus).reduce((a,b)=>a+b,0);
    const active=byStatus.aberto+byStatus.em_atendimento+byStatus.pendente_usuario;
    const categories=stmt(`SELECT category name,COUNT(*) value FROM tickets ${mine} GROUP BY category ORDER BY value DESC`,...arg);
    const teams=stmt(`SELECT team name,COUNT(*) value FROM tickets ${mine} GROUP BY team ORDER BY value DESC`,...arg);
    const monthly=stmt(`SELECT substr(created_at,1,7) month, COUNT(*) opened FROM tickets ${mine} GROUP BY substr(created_at,1,7) ORDER BY month DESC LIMIT 7`,...arg).reverse();
    const latest=ticketList({where:user.role==='requester'?'t.requester_id=?':'1=1',params:arg,limit:6});
    const assets=user.role==='requester'?one('SELECT COUNT(*) c FROM assets WHERE assigned_to=?',user.id).c:one('SELECT COUNT(*) c FROM assets').c;
    const users=user.role==='requester'?null:one('SELECT COUNT(*) c FROM users WHERE active=1').c;
    const unassigned=user.role==='requester'?0:one("SELECT COUNT(*) c FROM tickets WHERE assignee_id IS NULL AND status NOT IN ('resolvido','encerrado')").c;
    const lowStock=user.role==='requester'?0:one('SELECT COUNT(*) c FROM stock WHERE quantity<minimum AND active=1').c;
    const overdue=user.role==='requester'?one("SELECT COUNT(*) c FROM tickets WHERE requester_id=? AND due_at<datetime('now') AND status NOT IN ('resolvido','encerrado')",user.id).c:one("SELECT COUNT(*) c FROM tickets WHERE due_at<datetime('now') AND status NOT IN ('resolvido','encerrado')").c;
    return json(res,200,{total,active,unassigned,assets,users,lowStock,overdue,byStatus,categories,teams,monthly,latest});
  }
  if(pathname==='/api/users'&&req.method==='GET') {
    roleAtLeast(user);const q=trim(url.searchParams.get('q'),150),filter=url.searchParams.get('active');
    const clauses=[],args=[];
    if(q){clauses.push('(name LIKE ? OR email LIKE ? OR department LIKE ?)');args.push(...Array(3).fill(`%${q}%`));}
    if(filter==='1'||filter==='0'){clauses.push('active=?');args.push(Number(filter));}
    const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
    const users=stmt(`SELECT id,azure_oid,name,email,username,department,branch,title,role,active,source FROM users ${where} ORDER BY active DESC,name LIMIT 600`,...args);
    return json(res,200,{rows:users,total:one(`SELECT COUNT(*) c FROM users ${where}`,...args).c});
  }
  if(pathname==='/api/users/sync'&&req.method==='POST') {
    roleAtLeast(user,'admin');const result=await syncEntraUsers(user.id);publish('users');return json(res,200,result);
  }
  const userPatch=pathname.match(/^\/api\/users\/([^/]+)$/);
  if(userPatch&&req.method==='PATCH') {
    roleAtLeast(user,'admin');const target=one('SELECT * FROM users WHERE id=?',userPatch[1]);if(!target)return respondError(res,404,'Usuário não encontrado');
    const b=await readBody(req);
    if(b.role && !['admin','agent','requester'].includes(b.role))bad('Papel inválido');
    if(target.id===user.id && b.role && b.role!=='admin')bad('Não é possível remover o próprio acesso administrativo');
    if(b.role)run('UPDATE users SET role=? WHERE id=?',b.role,target.id);
    if(typeof b.active==='boolean' && target.source==='local' && config.demo && target.id!==user.id)
      run('UPDATE users SET active=? WHERE id=?',Number(b.active),target.id);
    audit(user.id,'user.update','user',target.id,JSON.stringify(b));publish('users');return json(res,200,{ok:true});
  }
  if(pathname==='/api/tickets'&&req.method==='GET') {
    const status=url.searchParams.get('status')||'',q=trim(url.searchParams.get('q'),150),owner=url.searchParams.get('owner')||'';
    const team=url.searchParams.get('team')||'',page=Math.max(1,int(url.searchParams.get('page'),1));
    const limit=Math.min(100,Math.max(1,int(url.searchParams.get('limit'),12)));
    const w=[],args=[];
    if(user.role==='requester'){w.push('t.requester_id=?');args.push(user.id);}
    if(status==='ativos')w.push("t.status NOT IN ('resolvido','encerrado')");
    else if(statuses.includes(status)){w.push('t.status=?');args.push(status);}
    if(owner==='me'){w.push('t.assignee_id=?');args.push(user.id);}
    else if(owner==='unassigned'){w.push('t.assignee_id IS NULL');}
    if(team){w.push('t.team=?');args.push(team);}
    if(q){w.push('(CAST(t.id AS TEXT) LIKE ? OR t.title LIKE ? OR u.name LIKE ? OR t.description LIKE ?)');args.push(...Array(4).fill(`%${q}%`));}
    const where=w.length?w.join(' AND '):'1=1';
    const rows=ticketList({where,params:args,limit,offset:(page-1)*limit});
    const total=one(`SELECT COUNT(*) c FROM tickets t JOIN users u ON u.id=t.requester_id WHERE ${where}`,...args).c;
    return json(res,200,{rows,total,page,pages:Math.max(1,Math.ceil(total/limit))});
  }
  if(pathname==='/api/tickets'&&req.method==='POST') {
    const b=await readBody(req),title=required(b.title,'Assunto',120),description=required(b.description,'Descrição',5000);
    const requester=user.role==='requester'?user.id:(b.requester_id||user.id);
    const emp=one('SELECT id,active FROM users WHERE id=?',requester);if(!emp?.active)bad('Solicitante inválido ou inativo');
    const category=cat.includes(b.category)?b.category:'Geral';const priority=priorities.includes(b.priority)?b.priority:'media';
    const team=teamList.includes(b.team)?b.team:'Service Desk';
    const hours={critica:4,alta:8,media:24,baixa:72}[priority];
    const due=new Date(Date.now()+hours*3600000).toISOString().replace('T',' ').slice(0,19);
    const r=run('INSERT INTO tickets(requester_id,title,description,category,team,priority,source,due_at) VALUES(?,?,?,?,?,?,?,?)',requester,title,description,category,team,priority,'portal',due);
    const id=Number(r.lastInsertRowid);
    run("INSERT INTO ticket_messages(ticket_id,author_id,author_name,body,channel) VALUES(?,?,?,?,'portal')",id,user.id,user.name,description);
    audit(user.id,'ticket.create','ticket',id);publish('tickets');return json(res,201,{id});
  }
  const ticketPath=pathname.match(/^\/api\/tickets\/(\d+)(?:\/(messages))?$/);
  if(ticketPath) {
    const id=int(ticketPath[1]);const t=accessibleTicket(id,user);
    if(req.method==='GET'&&!ticketPath[2]){
      const messages=stmt('SELECT id,author_id,author_name,body,channel,delivery,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY id',id);
      const updates=stmt("SELECT created_at,actor_id,action,detail FROM audit WHERE entity='ticket' AND entity_id=? ORDER BY id DESC LIMIT 20",String(id));
      return json(res,200,{ticket:t,messages,updates});
    }
    if(req.method==='PATCH'&&!ticketPath[2]){
      roleAtLeast(user);const b=await readBody(req),changes=[];
      if('status' in b){if(!statuses.includes(b.status))bad('Situação inválida');changes.push(['status',b.status]);}
      if('priority' in b){if(!priorities.includes(b.priority))bad('Prioridade inválida');changes.push(['priority',b.priority]);}
      if('team' in b){if(!teamList.includes(b.team))bad('Fila inválida');changes.push(['team',b.team]);}
      if('assignee_id' in b){if(b.assignee_id!==null){const u=one('SELECT * FROM users WHERE id=?',b.assignee_id);if(!u?.active||u.role==='requester')bad('Responsável não é agente ativo');}changes.push(['assignee_id',b.assignee_id]);}
      if(!changes.length)bad('Nenhuma alteração');
      for(const [field,value] of changes)run(`UPDATE tickets SET ${field}=?,updated_at=datetime('now') WHERE id=?`,value,id);
      if(b.status==='encerrado'||b.status==='resolvido')run('UPDATE tickets SET closed_at=datetime(\'now\') WHERE id=?',id);
      else if('status' in b)run('UPDATE tickets SET closed_at=NULL WHERE id=?',id);
      audit(user.id,'ticket.update','ticket',id,JSON.stringify(Object.fromEntries(changes)));
      publish('tickets');return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&ticketPath[2]==='messages'){
      const b=await readBody(req),body=required(b.body,'Mensagem',3500);
      const isAgent=user.role!=='requester';
      const result=run('INSERT INTO ticket_messages(ticket_id,author_id,author_name,body,channel,delivery) VALUES(?,?,?,?,?,?)',id,user.id,user.name,body,'portal',isAgent?'pendente':'local');
      run("UPDATE tickets SET updated_at=datetime('now') WHERE id=?",id);
      audit(user.id,'ticket.reply','ticket',id);publish('ticket_messages');
      let delivery={status:'local'};
      if(isAgent) {
        delivery=await replyTeamsForTicket(t,`${user.name}: ${body}`);
        run('UPDATE ticket_messages SET delivery=? WHERE id=?',delivery.status,Number(result.lastInsertRowid));
      }
      return json(res,201,{ok:true,delivery});
    }
  }
  if(pathname==='/api/assets'&&req.method==='GET') {
    roleAtLeast(user);const q=trim(url.searchParams.get('q'),120);
    const rows=stmt(`SELECT a.*,u.name assigned_name FROM assets a LEFT JOIN users u ON u.id=a.assigned_to
      WHERE a.tag LIKE ? OR a.model LIKE ? OR a.serial LIKE ? OR u.name LIKE ? ORDER BY a.tag LIMIT 600`,...Array(4).fill(`%${q}%`));
    return json(res,200,{rows,total:rows.length});
  }
  if(pathname==='/api/assets'&&req.method==='POST') {
    roleAtLeast(user);const b=await readBody(req);const tag=required(b.tag,'Patrimônio',90).toUpperCase();
    if(one('SELECT id FROM assets WHERE tag=?',tag))bad('Patrimônio já cadastrado');
    if(b.assigned_to&&!one('SELECT id FROM users WHERE id=? AND active=1',b.assigned_to))bad('Colaborador inválido ou inativo');
    const id=uid();run(`INSERT INTO assets(id,tag,category,brand,model,serial,cpu,ram,branch,department,status,assigned_to,warranty_until,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,tag,required(b.category,'Categoria',80),trim(b.brand),trim(b.model),trim(b.serial),trim(b.cpu),trim(b.ram),trim(b.branch),trim(b.department),b.assigned_to?'em_uso':'disponivel',b.assigned_to||null,trim(b.warranty_until,10)||null,trim(b.notes,1000));
    audit(user.id,'asset.create','asset',id,tag);publish('assets');return json(res,201,{id});
  }
  const assetPath=pathname.match(/^\/api\/assets\/([^/]+)$/);
  if(assetPath) {
    roleAtLeast(user);const a=one('SELECT * FROM assets WHERE id=?',assetPath[1]);if(!a)return respondError(res,404,'Ativo não encontrado');
    if(req.method==='GET')return json(res,200,{asset:a,history:stmt('SELECT h.*,u.name actor FROM asset_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.asset_id=? ORDER BY h.id DESC',a.id),software:stmt('SELECT s.* FROM software s JOIN asset_software l ON l.software_id=s.id WHERE l.asset_id=?',a.id)});
    if(req.method==='PATCH'){
      const b=await readBody(req);
      const status=b.status||a.status; if(!['disponivel','em_uso','manutencao','descartado'].includes(status))bad('Situação inválida');
      let assigned='assigned_to' in b ? b.assigned_to:a.assigned_to;
      if(assigned){const recipient=one('SELECT * FROM users WHERE id=?',assigned);if(!recipient?.active)bad('Colaborador não encontrado ou inativo');}
      if(status!=='em_uso')assigned=null;
      else if(!assigned)bad('Informe o colaborador para o ativo em uso');
      run(`UPDATE assets SET status=?,assigned_to=?,notes=?,warranty_until=? WHERE id=?`,status,assigned,trim(b.notes??a.notes,1000),trim(b.warranty_until??a.warranty_until,10)||null,a.id);
      run('INSERT INTO asset_history(asset_id,actor_id,from_user,to_user,action,note) VALUES(?,?,?,?,?,?)',a.id,user.id,a.assigned_to||null,assigned||null,assigned!==a.assigned_to?'transferencia':'atualizacao',trim(b.note,500));
      audit(user.id,'asset.update','asset',a.id);publish('assets');return json(res,200,{ok:true});
    }
  }
  if(pathname==='/api/stock'&&req.method==='GET') {
    roleAtLeast(user);const rows=stmt('SELECT *,CASE WHEN quantity<minimum THEN 1 ELSE 0 END low FROM stock WHERE active=1 ORDER BY category,description');
    return json(res,200,{rows});
  }
  if(pathname==='/api/stock'&&req.method==='POST') {
    roleAtLeast(user);const b=await readBody(req),id=uid();
    const minimum=int(b.minimum);if(minimum<0)bad('Mínimo inválido');
    run('INSERT INTO stock(id,category,description,brand,model,minimum) VALUES(?,?,?,?,?,?)',id,required(b.category,'Categoria',80),required(b.description,'Descrição',180),trim(b.brand),trim(b.model),minimum);
    audit(user.id,'stock.create','stock',id);publish('stock');return json(res,201,{id});
  }
  const stockMove=pathname.match(/^\/api\/stock\/([^/]+)\/movements$/);
  if(stockMove&&req.method==='POST'){
    roleAtLeast(user);const item=one('SELECT * FROM stock WHERE id=? AND active=1',stockMove[1]);if(!item)return respondError(res,404,'Item não encontrado');
    const b=await readBody(req),quantity=int(b.quantity),type=b.type;
    if(!['entrada','saida'].includes(type)||quantity<1||quantity>100000)bad('Movimentação inválida');
    if(type==='saida'&&quantity>item.quantity)bad('Estoque insuficiente');
    if(b.recipient_id && !one('SELECT id FROM users WHERE id=? AND active=1',b.recipient_id))bad('Colaborador não localizado');
    db.exec('BEGIN');try {
      run('UPDATE stock SET quantity=quantity+? WHERE id=?',(type==='entrada'?1:-1)*quantity,item.id);
      run('INSERT INTO stock_movements(item_id,actor_id,type,quantity,note,recipient_id) VALUES(?,?,?,?,?,?)',item.id,user.id,type,quantity,trim(b.note,500),b.recipient_id||null);
      audit(user.id,'stock.move','stock',item.id,`${type}:${quantity}`);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    publish('stock');return json(res,200,{ok:true});
  }
  if(pathname==='/api/software'&&req.method==='GET'){
    roleAtLeast(user);const rows=stmt(`SELECT s.*,(SELECT COUNT(*) FROM asset_software x WHERE x.software_id=s.id) installed FROM software s ORDER BY s.name`);
    return json(res,200,{rows});
  }
  if(pathname==='/api/software'&&req.method==='POST'){
    roleAtLeast(user);const b=await readBody(req),id=uid(),licenses=int(b.licenses);
    if(licenses<0)bad('Licenças inválidas');
    run('INSERT INTO software(id,name,description,licenses,is_licensed,expires_at) VALUES(?,?,?,?,?,?)',id,required(b.name,'Nome',150),trim(b.description,500),licenses,Number(!!b.is_licensed),trim(b.expires_at,10)||null);
    audit(user.id,'software.create','software',id);publish('software');return json(res,201,{id});
  }
  const softwarePath=pathname.match(/^\/api\/software\/([^/]+)$/);
  if(softwarePath&&req.method==='PATCH'){
    roleAtLeast(user);const s=one('SELECT * FROM software WHERE id=?',softwarePath[1]);if(!s)return respondError(res,404,'Software não localizado');
    const b=await readBody(req);if('licenses' in b&&int(b.licenses)<0)bad('Licenças negativas');
    run('UPDATE software SET name=?,description=?,licenses=?,is_licensed=?,active=?,expires_at=? WHERE id=?',trim(b.name??s.name),trim(b.description??s.description),int(b.licenses??s.licenses),Number(b.is_licensed??s.is_licensed),Number(b.active??s.active),trim(b.expires_at??s.expires_at,10)||null,s.id);
    audit(user.id,'software.update','software',s.id);publish('software');return json(res,200,{ok:true});
  }
  const assetSoft=pathname.match(/^\/api\/assets\/([^/]+)\/software$/);
  if(assetSoft&&req.method==='POST') {
    roleAtLeast(user);const b=await readBody(req);if(!one('SELECT id FROM assets WHERE id=?',assetSoft[1])||!one('SELECT id FROM software WHERE id=?',b.software_id))bad('Ativo ou software inválido');
    if(b.installed===false)run('DELETE FROM asset_software WHERE asset_id=? AND software_id=?',assetSoft[1],b.software_id);
    else run('INSERT OR IGNORE INTO asset_software(asset_id,software_id) VALUES(?,?)',assetSoft[1],b.software_id);
    audit(user.id,'asset.software','asset',assetSoft[1]);publish('software');return json(res,200,{ok:true});
  }
  if(pathname==='/api/audit'&&req.method==='GET'){
    roleAtLeast(user,'admin');
    const rows=stmt('SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON a.actor_id=u.id ORDER BY a.id DESC LIMIT 150');
    return json(res,200,{rows});
  }
  if(pathname==='/api/settings'&&req.method==='GET'){
    roleAtLeast(user,'admin');return json(res,200,{integrations:integrationHealth(),tenant:config.tenant?`${config.tenant.slice(0,8)}…`:'não configurado',botInstalled:one('SELECT COUNT(*) c FROM teams_connections').c,apiVersion:'v1',runtime:process.version});
  }
  if(pathname==='/api/reports/tickets.csv'&&req.method==='GET') {
    roleAtLeast(user);
    const rows=stmt('SELECT t.id,t.title,t.category,t.team,t.priority,t.status,t.source,t.created_at,t.closed_at,u.name requester,a.name assigned FROM tickets t JOIN users u ON u.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id ORDER BY t.id DESC LIMIT 20000');
    const keys=['id','title','category','team','priority','status','source','created_at','closed_at','requester','assigned'];
    const csv='\ufeff'+keys.map(csvCell).join(';')+'\r\n'+rows.map(row=>keys.map(k=>csvCell(row[k])).join(';')).join('\r\n');
    res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="solvia-chamados.csv"','cache-control':'no-store'});return res.end(csv);
  }
  return respondError(res,404,'Rota não encontrada');
}
function serveStatic(req,res,pathname){
  const target=pathname==='/'?'/index.html':pathname;
  const file=path.resolve(publicDir,'.'+target);
  if(!file.startsWith(publicDir+path.sep))return respondError(res,403,'Caminho inválido');
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()) return respondError(res,404,'Página não encontrada');
  res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",'referrer-policy':'strict-origin-when-cross-origin'});
  fs.createReadStream(file).pipe(res);
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,config.baseUrl);
    if(!req.url.startsWith('/'))return respondError(res,400,'URL inválida');
    instrument(req,res,url.pathname);
    if(url.pathname==='/internal/metrics' && req.method==='GET') {
      const permission=authorized(req);
      if(permission===null) return respondError(res,404,'Rota não encontrada');
      if(!permission) return respondError(res,401,'Não autorizado');
      res.writeHead(200,{'content-type':'text/plain; version=0.0.4; charset=utf-8','cache-control':'no-store'});
      return res.end(renderMetrics());
    }
    checkThrottle(req.socket.remoteAddress||'unknown');
    checkOrigin(req);
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('x-frame-options','DENY');
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(req.method==='GET')return serveStatic(req,res,url.pathname);
    return respondError(res,405,'Método não permitido');
  }catch(err){
    const status=err.status||(/^SQLITE_CONSTRAINT/.test(err.code||'')?409:500);
    if(status>=500)console.error(`[${new Date().toISOString()}]`,err.stack||err.message);
    if(!res.headersSent)respondError(res,status,status>=500?'Erro interno. Consulte o terminal para detalhes.':err.message);
  }
});
if(!config.demo && config.tenant && config.clientId && config.clientSecret) {
  const minutes=Math.max(0,Number(process.env.ENTRA_SYNC_INTERVAL_MINUTES||0));
  if(minutes>=15) {
    const interval=setInterval(()=>syncEntraUsers(null).then(r=>{ console.log('Entra sync:',r.total);publish('users'); }).catch(e=>console.error('Entra auto-sync:',e.message)),minutes*60*1000);
    interval.unref();
  }
}
server.listen(config.port,config.host,()=>{
  console.log(`\n  SOLVIA ServiceOps • http://${config.host}:${config.port}`);
  console.log(`  Mode: ${config.demo?'DEMONSTRAÇÃO':'CORPORATIVO'} | Database: data/solvia.sqlite`);
  console.log(`  Entra: ${integrationHealth().entra} | Teams: ${integrationHealth().teams}\n`);
});
let stopping=false;
function shutdown(signal) {
  if(stopping) return;
  stopping=true;
  console.log(`Encerrando Solvia: ${signal}`);
  // Feche SSE e conexões ativas no limite de tempo para dar lugar ao novo Pod.
  const timer=setTimeout(()=>{server.closeAllConnections();process.exitCode=1;},12000);
  timer.unref();
  for(const res of subscribers) {try{res.end();}catch{}}
  server.close(()=>{clearTimeout(timer);db.close();});
}
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
