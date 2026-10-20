import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {config} from '../server/config.mjs';
if(!config.botId||!config.botTenant||!config.baseUrl.startsWith('https://')) {
  console.error('Configure BOT_APP_ID, BOT_TENANT_ID e BASE_URL=https://seu-dominio no .env antes de gerar o pacote Teams.');
  process.exit(1);
}
const folder=path.resolve('teams-app');fs.mkdirSync(folder,{recursive:true});
const uuidPath=path.join(folder,'app-id.txt');
const appId=fs.existsSync(uuidPath)?fs.readFileSync(uuidPath,'utf8').trim():randomUUID();
if(!fs.existsSync(uuidPath))fs.writeFileSync(uuidPath,appId);
const domain=new URL(config.baseUrl).hostname;
const manifest={
 '$schema':'https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json',
 manifestVersion:'1.19',version:'1.0.0',id:appId,packageName:'com.solvia.serviceops',
 developer:{name:'Solvia Service Operations',websiteUrl:config.baseUrl,privacyUrl:config.baseUrl+'/privacy.html',termsOfUseUrl:config.baseUrl+'/terms.html'},
 name:{short:'Solvia ServiceOps',full:'Solvia — Central de Atendimento e Service Desk'},
 description:{short:'Abra e acompanhe chamados de TI por chat.',full:'Canal de atendimento da Solvia para abrir solicitações, receber respostas do suporte e acompanhar chamados diretamente no Microsoft Teams.'},
 icons:{outline:'outline.png',color:'color.png'},accentColor:'#5368D9',
 bots:[{botId:config.botId,scopes:['personal'],supportsFiles:false,isNotificationOnly:false,commandLists:[{scopes:['personal'],commands:[{title:'novo:',description:'Abre um chamado a partir da mensagem'},{title:'ajuda',description:'Mostra como usar o atendimento'}]}]}],
 permissions:['identity','messageTeamMembers'],validDomains:[domain]
};
fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(`\nManifest gerado: teams-app/manifest.json`);
console.log(`ID aplicativo Teams: ${appId}`);
console.log('Crie um ZIP contendo apenas manifest.json, color.png e outline.png.');
console.log('PowerShell: Compress-Archive -Path teams-app/manifest.json,teams-app/color.png,teams-app/outline.png -DestinationPath Solvia-Teams.zip -Force');
console.log('Instale no Teams Admin Center após registrar o recurso Azure Bot e configurar o endpoint público HTTPS.\n');
