// Rotina local diária: cópias no mesmo host NÃO são backup externo.
import {spawn} from 'node:child_process';
const hours=Number(process.env.BACKUP_INTERVAL_HOURS || 24);
if (!Number.isFinite(hours) || hours < 1) throw new Error('BACKUP_INTERVAL_HOURS deve ser >= 1');
let stopping=false;
function backup() {
  if(stopping)return;
  const start=new Date().toISOString();
  console.log(`Agendador: iniciando snapshot ${start}`);
  const child=spawn(process.execPath,['scripts/backup.mjs'],{stdio:'inherit',env:process.env});
  child.on('exit',code=>console.log(`Agendador: conclusão ${new Date().toISOString()} (codigo ${code})`));
}
backup();
const timer=setInterval(backup,hours*3600000);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;clearInterval(timer);});
