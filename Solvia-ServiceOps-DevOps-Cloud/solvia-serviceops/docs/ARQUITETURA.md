# Visão técnica — Solvia ServiceOps 1.0

## Objetivos de arquitetura

Aplicação simples de executar e adaptar no VS Code, com separação clara entre interface web, API e persistência. Não exige Docker, framework frontend, compilação ou dependências de terceiros. **Isso reduz barreiras para testar**, mas não deve ser confundido com arquitetura distribuída de alta disponibilidade.

| Camada | Implementação |
|---|---|
| Apresentação | SPA JavaScript modular em `public/app.js`, CSS próprio em `public/style.css` |
| API | HTTP nativo do Node.js (`server/index.mjs`), JSON e SSE |
| Banco de dados | SQLite via `node:sqlite` com journal WAL, índices e chaves estrangeiras |
| Sessão | Cookies HttpOnly, SameSite Lax, `Secure` em produção, token aleatório com hash SHA-256 no banco |
| Login local de demo | scrypt com salt por usuário, desabilitado em modo corporativo |
| Login corporativo | OAuth2 Authorization Code + PKCE, identificação no Graph `/me` |
| Graph | Client Credentials com token e `GET /v1.0/users` paginado, campo `accountEnabled` |
| Teams | Webhook do Bot Connector com JWT validado por JWKS + envio via Bot Connector API |
| Mensagens | Armazenamento persistente das mensagens + atualização em tempo real por SSE |
| Auditoria | Eventos de criação, atualização, movimentação, login, sincronização e mudança de papel |

## Principais tabelas

- `users`: identidade, status, origem e papéis.
- `sessions`: hashes dos tokens e proteção CSRF por sessão.
- `tickets`: solicitação, classificação, fila, status, prioridade, solicitante, responsável, origem e datas.
- `ticket_messages`: conversas portal/Teams, identificação externa para deduplicação e estado de entrega.
- `teams_connections`: conversa pessoal Teams vinculada à identidade corporativa.
- `assets` e `asset_history`: inventário e histórico de transferências.
- `stock` e `stock_movements`: saldo, estoque mínimo e movimentações de entradas/saídas.
- `software` e `asset_software`: catálogo/licenciamento e sistemas por ativo.
- `audit`: trilha de auditoria.

## Endpoints relevantes

| Método | Rota | Permissão |
|---|---|---|
| GET | `/api/health` | Pública, sem segredos |
| POST | `/api/auth/login` | Somente demo |
| GET | `/api/auth/microsoft` | Login OAuth de produção |
| GET | `/api/auth/me` | Perfil e CSRF da sessão |
| GET | `/api/dashboard` | Todos; dados limitados por papel |
| GET/POST | `/api/tickets` | Todos; solicitante só cria e vê seus chamados |
| GET/PATCH | `/api/tickets/:id` | GET próprio para solicitante; PATCH apenas equipe |
| POST | `/api/tickets/:id/messages` | Participantes autorizados |
| GET | `/api/users` | Suporte e administração |
| PATCH | `/api/users/:id` | Administração |
| POST | `/api/users/sync` | Administração e Graph configurado |
| GET/POST/PATCH | `/api/assets` e `/api/assets/:id` | Suporte e administração |
| GET/POST | `/api/stock` | Suporte e administração |
| POST | `/api/stock/:id/movements` | Suporte e administração |
| GET/POST/PATCH | `/api/software` e `/api/software/:id` | Suporte e administração |
| GET | `/api/reports/tickets.csv` | Suporte e administração |
| GET | `/api/audit` | Administração |
| POST | `/api/teams/messages` | Somente Bot Connector autenticado |

## Segurança implementada

1. Autorização por papel **no backend**, não somente esconder links no frontend.
2. Conta `active=0` bloqueada na autenticação e no recebimento das mensagens Teams.
3. Proteção CSRF para mutações no portal, verificação de origem quando `Origin` é enviado, limitação básica de solicitações por IP.
4. Sessões persistidas com hash, cookies sem acesso JavaScript.
5. CSP restritiva, bloqueio de framing e de MIME sniffing.
6. `serviceUrl` do bot limitado a domínios HTTPS confiáveis para atenuar SSRF.
7. Segredos via `.env`, que não é empacotado no ZIP.
8. Consultas SQL parametrizadas, movimento de estoque transacional.

## Limitações para evoluir em um projeto enterprise

A arquitetura foi intencionalmente limitada a **um processo Node e um arquivo SQLite**. Não possui fila resiliente de jobs/reenvios, armazenamento distribuído de anexos, observabilidade centralizada, criptografia por coluna, retenção automatizada, cluster horizontal, motor de SLA comercial por calendário, integração de licenças reais do M365 ou sincronização incremental Graph Delta. Esses recursos exigem especificação de negócio e infraestrutura.

Para escala maior, um caminho de evolução é PostgreSQL + migrações, sessões em Redis, workers para integrações, fila de mensagens e transações, API versionada com contratos OpenAPI, suíte E2E no CI, logs centralizados e snapshots/backup monitorados.
