# Implantação Microsoft 365 — Entra ID + Microsoft Teams

Este documento foi escrito para a pessoa que vai configurar a aplicação com acesso de administrador no Microsoft Entra ID, Microsoft Teams Admin Center e Azure. As integrações **não** recebem acesso automático apenas por descompactar o ZIP: o administrador precisa aprovar os aplicativos e publicar o servidor de forma segura.

## 1. Conceitos importantes

- **AD local**: Windows Active Directory instalado em controladores de domínio. O Solvia **não** lê LDAP diretamente.
- **Microsoft Entra ID**: diretório na nuvem. Se a empresa sincroniza o AD local pelo Microsoft Entra Connect, os usuários aparecem no Entra ID e podem ser consultados pela aplicação.
- **Microsoft Graph**: API usada aqui para consultar `accountEnabled` (ativo/inativo), nome, UPN, e-mail, departamento, cargo e localização.
- **Microsoft Teams**: o colaborador conversa com o **bot pessoal Solvia** no Teams; o suporte acompanha o ticket e responde pelo portal. O bot devolve a resposta na conversa pessoal do mesmo colaborador. **Não se trata de criar um chat entre dois seres humanos.**

## 2. Pré-requisitos

- Tenant Microsoft 365 com acesso administrativo para registrar apps, aprovar permissões e instalar apps no Teams.
- Acesso ao Azure para criar um recurso **Azure Bot** e conectar o canal **Microsoft Teams**.
- Servidor com Node 22.13+ ou LTS atual, disco persistente, backup e URL **HTTPS pública** acessível pelo serviço Microsoft. Uma máquina em `localhost` não recebe webhooks do Teams sem túnel/publicação apropriados.
- Domínio com certificado válido. Recomenda-se proxy reverso (IIS/ARR, Nginx ou Caddy), expor somente HTTPS 443, não publicar diretamente SQLite nem as portas internas.

## 3. Registrar app do Microsoft Graph (login e diretório)

1. Acesse https://entra.microsoft.com → **Identidade → Aplicativos → Registros de aplicativos → Novo registro**.
2. Nome: `Solvia ServiceOps — Directory`. Escolha **Somente contas neste diretório organizacional** (single-tenant).
3. Copie **Directory (tenant) ID** e **Application (client) ID**.
4. Vá em **Certificados e segredos → Novo segredo do cliente**. Copie o **valor** do segredo (não o Secret ID). Em produção, prefira certificado/cofre de segredo e política de rotação; esta amostra usa segredo via .env.
5. Configure **Autenticação → Adicionar plataforma → Web → URI de redirecionamento**: `https://seu-dominio/api/auth/microsoft/callback`.
6. Em **Permissões de API → Microsoft Graph**, adicione:
   - **Delegada:** `User.Read` — login do colaborador, leitura do próprio perfil.
   - **Aplicativo:** `User.Read.All` — leitura dos usuários e campo `accountEnabled`.
7. Clique em **Conceder consentimento de administrador** (necessário para a permissão de aplicativo).
8. Preencha no `.env`:

```dotenv
DEMO_MODE=false
NODE_ENV=production
BASE_URL=https://seu-dominio
ENTRA_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ENTRA_CLIENT_ID=yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy
ENTRA_CLIENT_SECRET=valor-do-segredo
ENTRA_SYNC_INTERVAL_MINUTES=360
```

**Atenção:** `User.Read.All` é acesso de leitura a identidades, não uma licença para alterar/ativar/desativar contas no diretório. A aplicação nunca altera `accountEnabled` no Entra ID. O papel Solvia (admin/agente/colaborador) é administrado no banco local. Usuários ausentes de uma sincronização *completa* são marcados inativos no cadastro Solvia.

## 4. Criar o primeiro administrador de produção

1. Com o `.env` configurado, inicie o serviço (`npm start`).
2. Abra o site e entre com **Microsoft 365** usando seu usuário corporativo ativo; a aplicação cria seu cadastro como **Colaborador**.
3. No terminal da máquina do servidor, **com os direitos apropriados**, execute:

```bash
node server/cli.mjs promover-admin seu.email@empresa.com.br
```

4. Saia e entre novamente (ou atualize a sessão). Seu usuário passa a ter acesso à administração.
5. Em **Integrações e auditoria → Sincronizar agora**, importe os usuários do Entra ID. Em seguida, defina os papéis dos técnicos que atenderão chamados.

## 5. Registrar bot do Teams

1. No Azure, crie recurso **Azure Bot**, com identidade single-tenant no mesmo tenant corporativo.
2. Registre um aplicativo específico para o bot. Copie a **Microsoft App ID**, gere segredo e identifique o **Tenant ID**. Configure no `.env`:

```dotenv
BOT_APP_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
BOT_APP_PASSWORD=valor-do-segredo-do-bot
BOT_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

3. Configure a **Messaging endpoint** do Azure Bot como:

```
https://seu-dominio/api/teams/messages
```

4. No Azure Bot, habilite o canal **Microsoft Teams**. Configure corretamente as políticas de instalação de aplicativos na organização.
5. No diretório da aplicação, execute:

```bash
node scripts/gerar-teams.mjs
```

6. O comando cria `teams-app/manifest.json`, associado ao seu `BOT_APP_ID`, junto dos ícones `color.png` e `outline.png`.
7. Em PowerShell, dentro da pasta raiz, compacte **apenas estes três arquivos no nível principal do ZIP**:

```powershell
Compress-Archive -Path teams-app/manifest.json,teams-app/color.png,teams-app/outline.png -DestinationPath Solvia-Teams.zip -Force
```

8. Publique o ZIP no **Teams Admin Center → Teams apps → Manage apps → Upload new app** (os nomes das telas variam conforme o tenant e a versão).
9. Aprove e disponibilize o aplicativo Solvia aos colaboradores. Para conversas proativas, o bot deve estar instalado no escopo **pessoal** do usuário, ou já ter recebido uma atividade para armazenar a referência da conversa.
10. Abra o app no Teams com uma conta de teste. Envie `ajuda`, depois `novo: Não consigo conectar na VPN`. A mensagem deve gerar um ticket no portal e receber uma confirmação no chat.

## 6. Como as mensagens trafegam

```text
COLABORADOR (Teams pessoal)
       |
       | "novo: minha VPN não conecta"
       v
Azure Bot / Teams Channel
       |
       | POST /api/teams/messages (JWT verificado)
       v
Servidor Solvia -> usuários / tickets / mensagens (SQLite)
       |
       | API + Server-Sent Events
       v
ANALISTA (Portal Solvia)
       |
       | Responde no detalhe do chamado
       v
Bot Connector (autenticação de aplicativo)
       |
       v
MESMO CHAT do colaborador no Teams
```

**Comandos disponíveis no Teams**:

- `ajuda` — mostra orientação.
- `novo: Quero ajuda com a impressora` — cria **outro** chamado, mesmo que haja um chamado aberto.
- `Não consegui resolver o problema` — atualiza o último chamado ainda não concluído.
- `#1042 Continua sem funcionar` — envia mensagem para um chamado próprio com número específico.

**Regras e limites implementados:**

- O webhook valida assinatura JWT (chave JWKS oficial), emissor, audiência, validade, canal e tenant. Sem credenciais válidas, não aceita mensagens.
- O bot opera no **chat pessoal**. Mensagens em canais ou grupos não são aceitas por este fluxo.
- A referência da conversa pessoal (`conversation_id`, `service_url`, usuário Teams) fica armazenada no banco.
- Mensagens salvas no portal não são descartadas quando o Teams está indisponível. A entrega é marcada `falhou` ou `nao_conectado`; reenvio automático com fila persistente **não foi implementado**.
- Evite publicar dados secretos no Teams e trate anexos em um desenvolvimento específico. **Este MVP recebe texto; anexos não são processados.**
- Contas inativas não podem entrar no portal ou enviar novos chamados aceitos pela integração.
- Para usuário Microsoft que apareceu primeiramente no Teams (antes da sincronização do Graph), o sistema cria um identificador temporário associado ao `aadObjectId`; a sincronização pelo Graph atualiza os dados de nome, e-mail, setor e status.
- A habilitação real deve ser testada com o tenant específico da empresa: políticas de Conditional Access, Teams App policies, configurações de bot e permissões podem impedir a execução.

## 7. Se algo não funcionar

| Sintoma | Onde conferir |
|---|---|
| Microsoft retorna erro de consentimento | `User.Read` e `User.Read.All`, autorização do administrador, single-tenant |
| Callback falha | `BASE_URL` HTTPS **igual** ao redirect URI cadastrado |
| Contas não aparecem | Clique em sincronizar, confirme `User.Read.All` do aplicativo e se o AD local está no Entra |
| Bot não responde | Azure Bot endpoint público `/api/teams/messages`, canal Teams, manifesto e logs do servidor |
| 401/403 no webhook | Verifique App ID, tenant, expiração do segredo e assinatura do Bot Connector |
| Portal responde mas Teams não recebe | Bot instalado no pessoal do usuário, conversa capturada, acesso a Bot Connector e log de `delivery` |
| Preciso de AD local sem Entra Connect | É necessário criar uma integração LDAP/LDAPS ou agente Windows adicional (não incluso) |

### Documentação Microsoft oficial

- [Listar usuários com Microsoft Graph](https://learn.microsoft.com/pt-br/graph/api/user-list?view=graph-rest-1.0)
- [Enviar e receber mensagens no Bot Connector](https://learn.microsoft.com/pt-br/azure/bot-service/rest-api/bot-framework-rest-connector-send-and-receive-messages?view=azure-bot-service-4.0)
- [Autenticação do Bot Connector](https://learn.microsoft.com/pt-br/azure/bot-service/rest-api/bot-framework-rest-connector-authentication)
- [Mensagens proativas no Teams](https://learn.microsoft.com/pt-br/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)

**Aviso:** a plataforma Microsoft evolui. Revalide os passos e manifestos com a documentação da versão vigente antes de publicar na organização.
