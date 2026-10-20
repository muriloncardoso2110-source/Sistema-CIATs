// Snapshot SQLite consistente com VACUUM INTO, mesmo se app estiver escrevendo em WAL.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const source = path.resolve(process.env.SOLVIA_DATA_DIR || 'data', 'solvia.sqlite');
const directory = path.resolve(process.env.SOLVIA_BACKUP_DIR || 'backups');
const retention = Math.max(1, Math.min(365, Number(process.env.BACKUP_RETENTION_DAYS || 7)));
if (!fs.existsSync(source)) {console.error(`Banco não encontrado em ${source}`);process.exit(1);}
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(directory, `solvia-${stamp}.sqlite`);
const db = new DatabaseSync(source, {readOnly:true});
try {
  const health = db.prepare('PRAGMA quick_check').get();
  if (Object.values(health)[0] !== 'ok') throw new Error(`Integridade da origem: ${JSON.stringify(health)}`);
  // VACUUM INTO gera cópia transacional isolada de WAL ativo.
  db.prepare('VACUUM INTO ?').run(target);
  const snapshot = new DatabaseSync(target,{readOnly:true});
  try {
    if (Object.values(snapshot.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('Snapshot inválido');
  } finally { snapshot.close(); }
  fs.chmodSync(target,0o600);
  const cutoff = Date.now() - retention * 86400000;
  for (const name of fs.readdirSync(directory)) {
    if (/^solvia-\d{4}-\d\d-\d\dT[\d-]+Z\.sqlite$/.test(name)) {
      const file=path.join(directory,name);
      if (file !== target && fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  }
  console.log(`Backup íntegro: ${target} (${fs.statSync(target).size} bytes)`);
} catch(err) {
  if (fs.existsSync(target)) fs.rmSync(target);
  console.error(`Erro no backup: ${err.message}`);
  process.exitCode = 1;
} finally {db.close();}
