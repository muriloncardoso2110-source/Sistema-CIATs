import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { config } from './config.mjs';

const dataDir = path.resolve(process.env.SOLVIA_DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, 'solvia.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, azure_oid TEXT UNIQUE, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
 username TEXT, department TEXT DEFAULT '', branch TEXT DEFAULT '', title TEXT DEFAULT '',
 role TEXT NOT NULL DEFAULT 'requester' CHECK(role IN ('admin','agent','requester')),
 active INTEGER NOT NULL DEFAULT 1, source TEXT DEFAULT 'local', password_hash TEXT,
 updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id TEXT NOT NULL REFERENCES users(id),
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT DEFAULT 'Sistemas',
 team TEXT DEFAULT 'Service Desk', priority TEXT NOT NULL DEFAULT 'media',
 status TEXT NOT NULL DEFAULT 'aberto', assignee_id TEXT REFERENCES users(id),
 source TEXT DEFAULT 'portal', created_at TEXT DEFAULT (datetime('now')),
 updated_at TEXT DEFAULT (datetime('now')), closed_at TEXT, due_at TEXT
);
CREATE TABLE IF NOT EXISTS ticket_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
 author_id TEXT REFERENCES users(id), author_name TEXT NOT NULL, body TEXT NOT NULL,
 channel TEXT NOT NULL DEFAULT 'portal', delivery TEXT NOT NULL DEFAULT 'local',
 external_id TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS teams_connections (
 azure_oid TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 conversation_id TEXT NOT NULL, service_url TEXT NOT NULL, bot_id TEXT NOT NULL,
 teams_user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, tag TEXT UNIQUE NOT NULL, category TEXT NOT NULL, brand TEXT DEFAULT '',
 model TEXT DEFAULT '', serial TEXT DEFAULT '', cpu TEXT DEFAULT '', ram TEXT DEFAULT '',
 branch TEXT DEFAULT '', department TEXT DEFAULT '', status TEXT DEFAULT 'disponivel',
 assigned_to TEXT REFERENCES users(id), warranty_until TEXT, acquired_at TEXT,
 notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS asset_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL REFERENCES assets(id),
 actor_id TEXT REFERENCES users(id), from_user TEXT, to_user TEXT,
 action TEXT NOT NULL, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS stock (
 id TEXT PRIMARY KEY, category TEXT NOT NULL, description TEXT NOT NULL, brand TEXT DEFAULT '',
 model TEXT DEFAULT '', quantity INTEGER NOT NULL DEFAULT 0, minimum INTEGER NOT NULL DEFAULT 0,
 active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_movements (
 id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES stock(id),
 actor_id TEXT REFERENCES users(id), type TEXT NOT NULL, quantity INTEGER NOT NULL,
 note TEXT DEFAULT '', recipient_id TEXT REFERENCES users(id), created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS software (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
 licenses INTEGER NOT NULL DEFAULT 0, is_licensed INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS asset_software (
 asset_id TEXT NOT NULL REFERENCES assets(id), software_id TEXT NOT NULL REFERENCES software(id),
 PRIMARY KEY(asset_id, software_id)
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
 entity TEXT NOT NULL, entity_id TEXT, detail TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON tickets(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ticket_requester ON tickets(requester_id);
CREATE INDEX IF NOT EXISTS idx_ticket_assignee ON tickets(assignee_id);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(assigned_to);
`);
export const stmt = (sql, ...params) => db.prepare(sql).all(...params);
export const one = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);
export const uid = () => randomUUID();
export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const digestPassword = (password, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
export const audit = (actor, action, entity, id, detail='') => run('INSERT INTO audit(actor_id,action,entity,entity_id,detail) VALUES(?,?,?,?,?)',actor,action,entity,String(id),String(detail).slice(0,500));

if (config.demo && !one('SELECT id FROM users LIMIT 1')) {
  const insertUser = db.prepare('INSERT INTO users(id,name,email,username,department,branch,title,role,active,password_hash) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const users = [
    ['u-admin','Camila Almeida','admin@solvia.local','camila','Tecnologia','Matriz','Coordenação de TI','admin'],
    ['u-tech','Rafael Costa','suporte@solvia.local','rafael','Service Desk','Matriz','Analista de suporte','agent'],
    ['u-agent','Beatriz Lima','analista@solvia.local','beatriz','Infraestrutura','Matriz','Analista de infraestrutura','agent'],
    ['u-req','Marina Rodrigues','colaborador@solvia.local','marina','Financeiro','Matriz','Analista financeiro','requester'],
    ['u-ana','Lucas Ferreira','lucas@solvia.local','lucas','Comercial','Filial Sul','Assistente comercial','requester'],
    ['u-off','Felipe Gomes','inativo@solvia.local','felipe','Operações','Matriz','Assistente','requester']
  ];
  for (const [id,name,email,username,dept,branch,title,role] of users) insertUser.run(id,name,email,username,dept,branch,title,role,id==='u-off'?0:1,digestPassword('Solvia@2026'));
  const ts = (days=0) => new Date(Date.now() - days*86400000).toISOString().replace('T',' ').slice(0,19);
  const insertTicket = db.prepare('INSERT INTO tickets(id,requester_id,title,description,category,team,priority,status,assignee_id,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const examples = [
    [1042,'u-req','VPN desconecta ao acessar a rede interna','Conexão cai após alguns minutos.','Redes','Infraestrutura','alta','em_atendimento','u-tech','portal',0],
    [1041,'u-ana','Instalação do Microsoft 365','Necessário instalar o pacote na estação de trabalho.','Software','Service Desk','media','aberto',null,'portal',0],
    [1040,'u-req','Erro no acesso ao sistema ERP','Mensagem de acesso negado ao autenticar.','Sistemas','Aplicações','critica','pendente_usuario','u-agent','teams',1],
    [1039,'u-ana','Solicitação de novo monitor','Necessário monitor adicional para a equipe.','Equipamentos','Service Desk','baixa','aberto',null,'portal',1],
    [1038,'u-req','Impressora do financeiro offline','Impressora não responde pela rede.','Impressoras','Service Desk','media','em_atendimento','u-tech','portal',2],
    [1037,'u-ana','Redefinição de senha','Não consigo acessar minha conta corporativa.','Acessos','Service Desk','alta','resolvido','u-tech','portal',3],
    [1036,'u-req','Atualização do antivírus','Preciso verificar o antivírus após alerta.','Segurança','Infraestrutura','media','encerrado','u-agent','portal',7],
    [1035,'u-ana','Lentidão na inicialização','Computador leva muitos minutos para iniciar.','Equipamentos','Service Desk','baixa','em_atendimento','u-tech','portal',8]
  ];
  for (const [id,requester,title,description,category,team,priority,status,assignee,source,days] of examples) insertTicket.run(id,requester,title,description,category,team,priority,status,assignee,source,ts(days),ts(days));
  const insertMessage = db.prepare('INSERT INTO ticket_messages(ticket_id,author_id,author_name,body,channel) VALUES(?,?,?,?,?)');
  insertMessage.run(1042,'u-req','Marina Rodrigues','A VPN conecta, mas cai em seguida.','portal');
  insertMessage.run(1042,'u-tech','Rafael Costa','Recebemos sua solicitação. Vou verificar os logs do acesso.','portal');
  insertMessage.run(1040,'u-req','Marina Rodrigues','Consegui anexar o erro pelo Teams?','teams');
  insertMessage.run(1040,'u-agent','Beatriz Lima','Verifique se o perfil foi liberado e tente novamente.','portal');
  const insertAsset = db.prepare('INSERT INTO assets(id,tag,category,brand,model,serial,cpu,ram,branch,department,status,assigned_to,warranty_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  [
    ['a1','SLV-00241','Notebook','Dell','Latitude 5440','SN284001','Core i5-1345U','16 GB','Matriz','Financeiro','em_uso','u-req','2027-09-18'],
    ['a2','SLV-00242','Desktop','Dell','OptiPlex 7010','SN284002','Core i5-13500','16 GB','Matriz','Tecnologia','em_uso','u-tech','2027-03-22'],
    ['a3','SLV-00243','Notebook','Lenovo','ThinkPad E14','SN284003','Ryzen 7 7730U','16 GB','Filial Sul','Comercial','em_uso','u-ana','2026-09-08'],
    ['a4','SLV-00244','Monitor','LG','24MP400','SN284004','','','Matriz','Financeiro','disponivel',null,'2028-02-10'],
    ['a5','SLV-00245','Desktop','HP','ProDesk 400','SN284005','Core i5-10500','8 GB','Matriz','Operações','manutencao',null,'2025-08-07'],
    ['a6','SLV-00246','Notebook','Dell','Vostro 3520','SN284006','Core i5-1235U','8 GB','Matriz','Tecnologia','disponivel',null,'2027-01-13']
  ].forEach(a=>insertAsset.run(...a));
  const stockInsert = db.prepare('INSERT INTO stock(id,category,description,brand,model,quantity,minimum) VALUES(?,?,?,?,?,?,?)');
  [['st1','Teclado','Teclado USB ABNT2','Logitech','K120',12,4],['st2','Mouse','Mouse óptico USB','Logitech','M90',2,5],['st3','Headset','Headset com microfone','Jabra','Evolve 20',8,3],['st4','Adaptador','Adaptador HDMI USB-C','Ugreen','HDMI',1,4],['st5','Apoio','Suporte para notebook','Octoo','UpTable',6,2]].forEach(x=>stockInsert.run(...x));
  const swInsert = db.prepare('INSERT INTO software(id,name,description,licenses,is_licensed,active,expires_at) VALUES(?,?,?,?,?,?,?)');
  [['s1','Microsoft 365','Suite de produtividade',80,1,1,'2027-12-31'],['s2','Microsoft Teams','Colaboração corporativa',0,0,1,null],['s3','Adobe Acrobat','Editor de PDF',12,1,1,'2027-05-10'],['s4','Google Chrome','Navegador',0,0,1,null],['s5','7-Zip','Compactador de arquivos',0,0,1,null],['s6','Cliente VPN','Conexão remota',40,1,1,'2027-02-10']].forEach(x=>swInsert.run(...x));
  run('INSERT INTO asset_software(asset_id,software_id) VALUES(?,?)','a1','s1');
  run('INSERT INTO asset_software(asset_id,software_id) VALUES(?,?)','a1','s2');
  run('INSERT INTO asset_software(asset_id,software_id) VALUES(?,?)','a2','s1');
  run('INSERT INTO asset_software(asset_id,software_id) VALUES(?,?)','a3','s6');
}
