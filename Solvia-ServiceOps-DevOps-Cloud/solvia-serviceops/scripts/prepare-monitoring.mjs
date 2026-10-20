import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
const envFile='.env.monitoring',secretFile='infra/prometheus/metrics.token';
if (fs.existsSync(envFile) || fs.existsSync(secretFile)) {
  console.log('Arquivos de monitoramento já existem. Nada foi sobrescrito.');
  console.log('Para rotacionar segredos, planeje reiniciar app e Prometheus e substitua ambos atomica/consistentemente.');
  process.exit(0);
}
const token=randomBytes(32).toString('hex');
const admin=randomBytes(24).toString('hex');
fs.writeFileSync(envFile,`METRICS_TOKEN=${token}\nGRAFANA_ADMIN_PASSWORD=${admin}\n`,{mode:0o600,flag:'wx'});
fs.writeFileSync(secretFile,token,{mode:0o600,flag:'wx'});
console.log('Criados .env.monitoring e infra/prometheus/metrics.token (segredos excluídos do Git).');
console.log('A senha inicial do Grafana está em .env.monitoring (não coloque no repositório).');
