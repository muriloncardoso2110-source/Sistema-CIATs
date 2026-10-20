import fs from 'node:fs';
import path from 'node:path';
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^("|')|("|')$/g, '');
  }
}
export const config = {
  port: Number(process.env.PORT || 3100),
  host: process.env.HOST || '127.0.0.1',
  baseUrl: process.env.BASE_URL || 'http://localhost:3100',
  production: process.env.NODE_ENV === 'production',
  demo: process.env.DEMO_MODE !== 'false',
  tenant: process.env.ENTRA_TENANT_ID || '',
  clientId: process.env.ENTRA_CLIENT_ID || '',
  clientSecret: process.env.ENTRA_CLIENT_SECRET || '',
  botId: process.env.BOT_APP_ID || '',
  botPassword: process.env.BOT_APP_PASSWORD || '',
  botTenant: process.env.BOT_TENANT_ID || process.env.ENTRA_TENANT_ID || ''
};
