# Runbook operacional — Solvia ServiceOps

**Ambiente:** aplicação Node.js, SQLite WAL, Teams Bot, Microsoft Graph, Docker/Kubernetes. **Donos e contatos de plantão:** definir com equipe antes da entrada em produção.

## Diagnóstico inicial (qualquer incidente)

1. Registre incidente e horário. Não compartilhe JWTs, `.env`, mensagens de clientes ou dados pessoais no ticket público.
2. Verifique `GET /api/health` (processo vivo) e `GET /api/ready` (banco SQL consultável).
3. Consulte Grafana, Prometheus `up{job="solvia"}`, `solvia_http_server_errors_total` e logs de aplicação.
4. No Compose: `docker compose -f compose.production.yaml --env-file .env.production ps` e `... logs --tail=150 app proxy backup-scheduler`.
5. No Kubernetes: `kubectl -n solvia get pods,pvc,events`, `kubectl -n solvia logs deployment/solvia --tail=150`.
6. Verifique se há erro comum de DNS/TLS, serviço indisponível, PVC cheio ou segredo Microsoft expirado.

## Serviço indisponível / falha de readiness

- Confirme pod/container, `OOMKilled`, liveness, CPU/RAM, disco, permissão UID 1000 no volume, `solvia.sqlite` e arquivos WAL.
- Se banco corrompido, **não reinicie aleatoriamente**. Faça cópia forense dos arquivos, suspenda escritas e restore snapshot validado em ambiente isolado.
- Caso seja regressão de imagem, reverta para digest anterior aprovado. No Kubernetes: `kubectl -n solvia rollout history deployment/solvia` e `rollout undo` se houver revisão anterior. Lembre-se do intervalo de downtime por `Recreate`.
- Escale para operador de infraestrutura quando volume/host se tornar indisponível. SQLite não tem failover automático.

## Erros 5xx ou latência

- `sum(rate(solvia_http_requests_total{status="5xx"}[5m]))` e contagem `solvia_http_server_errors_total`.
- Verifique Graph/Bot Connector, respostas HTTP 429, timeout de APIs Microsoft, falha de conexão externa.
- Não aumente o número de réplicas como primeira tentativa; SQLite é mono-writer.
- Faça análise de causa-raiz com evento, duração, impacto, mitigação e ações preventivas.

## Respostas do Teams não chegam ao colaborador

- Confirme `BOT_APP_ID`, senha, tenant, canal Teams e o endpoint HTTPS `/api/teams/messages` no recurso Azure Bot.
- Verifique se bot está instalado no escopo **pessoal** do usuário e se existe referência `teams_connections` válida.
- Usuário precisa estar ativo no Entra e aplicação. Token do bot expirado, revogado ou sem permissão deve ser renovado por fluxo administrativo.
- Resposta que falhou pode ficar registrada no portal; não prometa entrega ao Teams sem evidência de sucesso no provedor.

## Não sincroniza usuários ativos/inativos

- Confira Microsoft Entra ID app single tenant, consentimento de admin `User.Read.All`, relógio e acesso a `graph.microsoft.com`.
- Na área administrativa use sincronização manual e compare amostra no diretório, inclusive `accountEnabled=false`.
- **Não** altere usuários no AD como resposta a falha da aplicação; procure TI de identidade. Dados de grupo e decisões de papel exigem governança.

## Espaço insuficiente no banco

- Verifique volume PVC ou volume Docker e retenção dos snapshots. Faça backup íntegro e cópia fora do host antes de mudanças.
- Não apague `solvia.sqlite-wal` nem `-shm` enquanto o processo estiver ativo.
- Escale volume conforme o provedor e monitore espaço livre. Reduza logs, estabeleça retenção LGPD e arquivamento futuro com aprovação.

## Backup, restore e evidência

- Snapshot: `docker compose --profile maintenance run --rm backup` (lab) ou aguarde agendador no Compose de produção.
- Verifique `PRAGMA integrity_check` no backup e reconstitua ambiente em laboratório isolado.
- Controle de acesso: cópias podem conter dados de chamados, ativos e usuários. Criptografe e minimize exposição.
- **RPO/RTO não estão garantidos nesta versão.** Definir alvos e testar restauração periódica antes de prometer SLA.

## Cloud AWS

- Queda na instância: console EC2, SSM Session Manager, checar status checks, volumes EBS, roteamento, SG e cloud-init.
- IP público pode alterar no stop/start; atualize DNS ou use solução de IP estável com custo estimado.
- Depois de laboratório, `terraform destroy` na pasta AWS, após extrair dados e validar recursos deletados.
