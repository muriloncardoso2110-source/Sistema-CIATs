import {one,run,audit} from './db.mjs';
const [command,email]=process.argv.slice(2);
if(command!=='promover-admin'||!email||!email.includes('@')) {
  console.log('Uso: node server/cli.mjs promover-admin seu.email@empresa.com.br');
  console.log('Primeiro faça login pelo Entra ID para criar seu usuário.');
  process.exit(1);
}
const user=one('SELECT * FROM users WHERE lower(email)=lower(?)',email);
if(!user||user.active!==1||!user.azure_oid){console.error('Usuário Entra ativo não localizado. Faça login Microsoft primeiro.');process.exit(1);}
run("UPDATE users SET role='admin' WHERE id=?",user.id);
audit(user.id,'cli.promote_admin','user',user.id,'Administração atribuída no terminal do servidor');
console.log(`Usuário ${user.email} autorizado como administrador.`);
