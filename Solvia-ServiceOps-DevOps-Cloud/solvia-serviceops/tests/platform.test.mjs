import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const temp=mkdtempSync(path.join(os.tmpdir(),'solvia-test-'));
const port=40000+Math.floor(Math.random()*15000);
const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server/index.mjs'],{cwd:path.resolve('.'),env:{...process.env,PORT:String(port),SOLVIA_DATA_DIR:temp,DEMO_MODE:'true',NODE_ENV:'test',HOST:'127.0.0.1',BASE_URL:base},stdio:['ignore','pipe','pipe']});
let debug='';child.stderr.on('data',d=>debug+=d.toString());
let cookie='',csrf='';
async function call(endpoint,method='GET',body,authed=true,csrfEnabled=true) {
 const headers={}; if(authed&&cookie)headers.cookie=cookie;
 if(method!=='GET'){headers['content-type']='application/json';if(csrfEnabled)headers['x-csrf-token']=csrf;}
 const res=await fetch(base+endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const data=endpoint.endsWith('.csv')?await res.text():await res.json();
 return {res,data};
}
async function login(email='admin@solvia.local',password='Solvia@2026') {
 const {res,data}=await call('/api/auth/login','POST',{email,password},false);
 if(res.ok){cookie=res.headers.get('set-cookie')?.split(';')[0];csrf=data.csrf;}
 return {res,data};
}

test('Integração: auth, filas, mensagens, ativos, estoque e controle de acesso',async(t)=>{
 await t.test('servidor inicializa',async()=>{
   let ready=false;for(let i=0;i<80;i++){try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break;}}catch{}await sleep(100);}
   assert.ok(ready,'servidor não iniciou: '+debug);
 });
 await t.test('contas inativas e senhas inválidas são bloqueadas',async()=>{
   assert.equal((await login('admin@solvia.local','senha-errada')).res.status,401);
   assert.equal((await login('inativo@solvia.local')).res.status,401);
 });
 await t.test('administrador pode entrar e ver indicadores',async()=>{
   assert.equal((await login()).res.status,200);
   const {data}=await call('/api/dashboard');
   assert.equal(data.total,8); assert.ok(data.byStatus.aberto>=2);
 });
 await t.test('requisições mutáveis exigem CSRF',async()=>{
   const {res}=await call('/api/tickets','POST',{title:'Falha de rede',description:'Computador sem acesso.'},true,false);
   assert.equal(res.status,403);
 });
 let ticketId;
 await t.test('abrir, responder, reclassificar e buscar chamado',async()=>{
   const create=await call('/api/tickets','POST',{title:'Chamado automatizado',description:'Descrição do teste integrado.',requester_id:'u-req',category:'Sistemas',priority:'alta'});
   assert.equal(create.res.status,201);ticketId=create.data.id;
   const list=await call('/api/tickets?status=ativos&q=Chamado%20automatizado');
   assert.equal(list.data.rows.length,1);
   const reply=await call(`/api/tickets/${ticketId}/messages`,'POST',{body:'O time iniciou sua análise.'});
   assert.equal(reply.res.status,201);assert.equal(reply.data.delivery.status,'nao_conectado');
   const update=await call(`/api/tickets/${ticketId}`,'PATCH',{assignee_id:'u-tech',status:'em_atendimento'});
   assert.equal(update.res.status,200);
   const detail=await call(`/api/tickets/${ticketId}`);assert.equal(detail.data.ticket.assignee_id,'u-tech');assert.ok(detail.data.messages.length>=2);
 });
 await t.test('cadastrar equipamento e movimentar inventário',async()=>{
   const add=await call('/api/assets','POST',{tag:'LAB-0099',category:'Notebook',brand:'Dell',model:'Vostro',warranty_until:'2028-01-01'});
   assert.equal(add.res.status,201);
   const update=await call(`/api/assets/${add.data.id}`,'PATCH',{status:'em_uso',assigned_to:'u-ana'});
   assert.equal(update.res.status,200);
   const asset=await call(`/api/assets/${add.data.id}`);assert.equal(asset.data.asset.assigned_to,'u-ana');assert.equal(asset.data.history.length,1);
 });
 await t.test('estoque não permite saldo negativo',async()=>{
   const add=await call('/api/stock','POST',{category:'Teclado',description:'Teclado para teste',minimum:2});assert.equal(add.res.status,201);
   const outgoing=await call(`/api/stock/${add.data.id}/movements`,'POST',{type:'saida',quantity:1});assert.equal(outgoing.res.status,400);
   const incoming=await call(`/api/stock/${add.data.id}/movements`,'POST',{type:'entrada',quantity:6});assert.equal(incoming.res.status,200);
   const outgoing2=await call(`/api/stock/${add.data.id}/movements`,'POST',{type:'saida',quantity:2,recipient_id:'u-req'});assert.equal(outgoing2.res.status,200);
   const items=await call('/api/stock');assert.equal(items.data.rows.find(x=>x.id===add.data.id).quantity,4);
 });
 await t.test('webhook Teams não aceita mensagem sem JWT válido',async()=>{
   const {res}=await call('/api/teams/messages','POST',{type:'message',text:'novo: oi'},false,false);
   assert.equal(res.status,503); // Sem bot configurado - falha fechada, sem inserção
 });
 await t.test('colaborador não tem acesso aos chamados de outra pessoa',async()=>{
   assert.equal((await login('colaborador@solvia.local')).res.status,200);
   const own=await call(`/api/tickets/${ticketId}`);assert.equal(own.res.status,200);
   const other=await call('/api/tickets/1039');assert.equal(other.res.status,403);
   const directory=await call('/api/users');assert.equal(directory.res.status,403);
   const ticketChange=await call(`/api/tickets/${ticketId}`,'PATCH',{status:'encerrado'});assert.equal(ticketChange.res.status,403);
 });
 await t.test('logout invalida sessão',async()=>{
   assert.equal((await call('/api/auth/logout','POST',{})).res.status,200);
   assert.equal((await call('/api/dashboard')).res.status,401);
 });
});

test.after(()=>{child.kill();rmSync(temp,{recursive:true,force:true});});
