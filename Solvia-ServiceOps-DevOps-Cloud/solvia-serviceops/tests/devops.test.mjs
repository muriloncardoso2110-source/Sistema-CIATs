import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

const root=path.resolve('.');
test('DevOps: backup online, autenticação de métricas, readiness e SIGTERM',async(t)=>{
  const temp=mkdtempSync(path.join(tmpdir(),'solvia-ops-'));
  const data=path.join(temp,'data');
  const backups=path.join(temp,'backups');
  const fs=await import('node:fs');fs.mkdirSync(data);
  let child;
  try {
    const db=new DatabaseSync(path.join(data,'solvia.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO records(body) VALUES (\'primeiro\'),(\'segundo\');');
    // Gera snapshot com conexão WAL de origem ainda aberta.
    const log=execFileSync(process.execPath,['scripts/backup.mjs'],{cwd:root,env:{...process.env,SOLVIA_DATA_DIR:data,SOLVIA_BACKUP_DIR:backups},encoding:'utf8'});
    assert.match(log,/Backup íntegro/);
    const [name]=readdirSync(backups).filter(f=>f.endsWith('.sqlite'));
    assert.ok(name);
    const copy=new DatabaseSync(path.join(backups,name),{readOnly:true});
    assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM records').get().count,2);
    assert.equal(Object.values(copy.prepare('PRAGMA integrity_check').get())[0],'ok');
    copy.close();db.close();
    await t.test('Métricas só são lidas com token e health verifica banco',async()=>{
      const port=45000+Math.floor(Math.random()*12000);
      const base=`http://127.0.0.1:${port}`;
      const token='secure-test-token-0123456789abcdef';
      child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,SOLVIA_DATA_DIR:data,DEMO_MODE:'true',NODE_ENV:'test',METRICS_TOKEN:token,HOST:'127.0.0.1',PORT:String(port),BASE_URL:base},stdio:'ignore'});
      let ready=false;
      for(let i=0;i<70;i++){
        try {const r=await fetch(base+'/api/ready');if(r.ok){ready=true;break;}}
        catch{}await sleep(100);
      }
      assert.ok(ready,'servidor não ficou pronto');
      assert.equal((await fetch(base+'/internal/metrics')).status,401);
      assert.equal((await fetch(base+'/internal/metrics',{headers:{Authorization:'Bearer bad'}})).status,401);
      const metric=await fetch(base+'/internal/metrics',{headers:{Authorization:`Bearer ${token}`}});
      assert.equal(metric.status,200);
      const body=await metric.text();
      assert.match(body,/solvia_http_requests_total/);
      assert.match(body,/solvia_open_tickets \d+/);
      assert.equal((await fetch(base+'/api/ready')).status,200);
      child.kill('SIGTERM');
      await new Promise(resolve=>child.once('exit',resolve));child=null;
    });
  } finally {if(child)child.kill('SIGKILL');rmSync(temp,{recursive:true,force:true});}
});
