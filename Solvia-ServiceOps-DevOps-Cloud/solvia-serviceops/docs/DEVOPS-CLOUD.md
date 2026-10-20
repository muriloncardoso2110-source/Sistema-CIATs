# SOLVIA SERVICEOPS — Guia DevOps & Cloud

**Escopo:** engenharia de entrega, containers, Kubernetes, CI/CD, observabilidade, backups, infraestrutura como código e implantação controlada do sistema de chamados + inventário + bot Teams.

> **O Solvia não migrou de banco.** Continua usando SQLite (`node:sqlite`, WAL). Portanto, implante **um único processo de escrita**, com armazenamento persistente e atualizações `Recreate` no Kubernetes. Não use HPA ou múltiplas réplicas. Para alta disponibilidade e escala horizontal de verdade, primeiro evolua para PostgreSQL e filas/jobs externos.

## 1 — Escolha como executar

| Ambiente | Requisitos | Custo de infraestrutura | Objetivo |
|---|---|---|---|
| Windows/VS Code | Node.js 22.13+ | Grátis (máquina própria) | Desenvolvimento sem Docker |
| Docker Compose | Docker Desktop/Engine + Compose v2 | Grátis localmente* | Desenvolvimento com container e volume |
| kind / Kubernetes | Docker + kind + kubectl | Grátis localmente* | Aprender orquestração, rolling strategy, health probes |
| AWS EC2 + Terraform | Conta AWS, Terraform, IAM, DNS | **Pode gerar cobranças reais** | Provisionar infraestrutura cloud e servir HTTPS |
| Microsoft Entra e Teams | Tenant corporativo, Microsoft Graph, Azure Bot | Dependente do tenant/licenciamento/consumo | Login corporativo e chat de atendimento |

*Suas máquinas, energia e eventuais recursos de terceiros não são gratuitos em sentido absoluto.

## 2 — Executar localmente sem Docker (recomendado se Docker falhar)

```powershell
# No PowerShell (diretório da aplicação):
Copy-Item .env.example .env
npm run check
npm test
npm start
```

Abra http://localhost:3100, usando `admin@solvia.local` e `Solvia@2026` (apenas demonstração). `INICIAR-WINDOWS.bat` faz inicialização simplificada. **Não use esses logins de teste na internet.**

## 3 — Docker Compose (Windows/Linux)

Instale Docker Desktop/Engine com Compose v2. Abra terminal na pasta raiz:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f app
```

- Portal: http://localhost:3100
- Health: http://localhost:3100/api/health
- Readiness: http://localhost:3100/api/ready
- Login: os mesmos usuários fictícios da demonstração
- O banco está no volume nomeado `solvia_data`, **não** dentro do container efêmero.
- A porta 3100 é publicada **somente para 127.0.0.1**.

Encerrar sem excluir dados:

```bash
docker compose down
```

**Atenção:** `docker compose down -v` remove os volumes e os dados locais. Utilize apenas para apagar explicitamente uma demonstração descartável.

### Backup consistente e teste de restauração

```bash
# Com aplicação em execução: o VACUUM INTO lê snapshot transacional em modo WAL.
docker compose --profile maintenance run --rm backup

# Ou sem Docker:
node scripts/backup.mjs
```

O modo Compose grava backups no volume `solvia_backups`. Para extrair cópia fora do host, execute:

```bash
# Substitua pelo nome real do container de backup, se estiver ativo,
# ou copie o volume com um container temporário com acesso controlado.
docker run --rm -v solvia-serviceops_solvia_backups:/origem:ro -v "${PWD}/export-backups:/destino" alpine:3.20 sh -c 'cp -a /origem/. /destino/'
```

O nome do volume varia conforme o projeto Compose (`docker volume ls`). **O segundo volume, sozinho, não protege de perda do servidor.** Transfira cópias criptografadas a outro host/cloud, teste restauração e defina política de retenção e acesso. O `backup-scheduler` do Compose de produção faz snapshots diários no mesmo host, mas **não implementa backup externo nem SLA de recuperação**.

**Restauração:** pare todos os processos que acessam SQLite (incluindo scheduler), copie o snapshot íntegro para a localização `solvia.sqlite` no volume de dados com permissão do UID 1000 e suba a aplicação novamente. Nunca restaure um `.sqlite` com aplicação escrevendo. Garanta que nenhum `-wal/-shm` do banco anterior permaneça após a parada coordenada. Teste em ambiente isolado antes de executar em produção.

## 4 — Monitoramento real com Prometheus + Grafana

O Solvia expõe `/internal/metrics`, **desabilitado sem `METRICS_TOKEN` forte (mínimo 24 caracteres)**. Quando habilitado, exige `Authorization: Bearer ...` e devolve métricas no formato Prometheus.

```bash
node scripts/prepare-monitoring.mjs
# Gera .env.monitoring e infra/prometheus/metrics.token, ignorados pelo Git.
docker compose --env-file .env.monitoring -f compose.yaml \
  -f infra/compose.observability.yaml up -d --build
```

| Destino | URL local |
|---|---|
| ServiceOps | http://localhost:3100 |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |

No Grafana entre com usuário **`admin`** e senha em `.env.monitoring` (`GRAFANA_ADMIN_PASSWORD`). O painel *Solvia | DevOps & ServiceOps* é provisionado automaticamente. Inclui chamados abertos, chamados sem técnico, itens abaixo do mínimo, disponibilidade, 5xx, RAM e tráfego. O Prometheus inclui alertas de disponibilidade, erros e estoque: **as regras estão prontas, mas notificações externas exigem configurar Alertmanager/contatos**.

**Segurança:** Prometheus/Grafana estão publicados apenas em `127.0.0.1` neste laboratório. Nunca disponibilize Prometheus ou Grafana sem autenticação, RBAC, TLS e política de acesso. O Caddy bloqueia `/internal/*` no domínio público.

## 5 — CI/CD GitHub Actions

Crie um repositório GitHub e envie o código (NÃO envie `.env`, `.env.production`, SQLite, tokens, segredos ou `terraform.tfstate`):

```bash
git init
git add .
git commit -m "feat: solvia platform and devops foundation"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/solvia-serviceops.git
git push -u origin main
```

### Pipeline principal `.github/workflows/ci.yml`

A cada pull request e push:

1. `npm run check` e testes de integração, backup, readiness e métricas.
2. `docker build` — Dockerfile multi-stage **executa a suíte de testes na montagem**.
3. Smoke test real de container e endpoint readiness.
4. Trivy — bloqueio de vulnerabilidades **CRITICAL** corrigíveis conforme base de vulnerabilidades.
5. `terraform fmt`, `terraform validate`, renderização Kubernetes local e produção.
6. Em `push` na branch `main` (ou tag `v*`): publica imagem no **GHCR** com tags branch/SHA/semver (quando aplicável), SBOM e proveniência.

Se o GHCR estiver privado, configure `imagePullSecret` no namespace Kubernetes ou autenticidade de pull no host. `GITHUB_TOKEN` autoriza publicação, sujeito às permissões de Packages do repositório. **Publicar a imagem não implanta automaticamente em um ambiente corporativo.**

### Publicação controlada em Kubernetes

`.github/workflows/deploy-kubernetes.yml` é `workflow_dispatch`: requer ativação manual, seleção da imagem e segredo de ambiente `KUBE_CONFIG_B64` contendo kubeconfig limitado a **somente o namespace necessário**. Configure **GitHub Environment `production` com aprovação obrigatória**. O job aplica os manifests, atualiza a imagem e aguarda readiness; faz tentativa de rollback se falhar.

Em ambientes corporativos prefira credenciais efêmeras/OIDC ou GitOps (Flux/Argo CD) a um kubeconfig de longa duração. Este workflow é um exemplo operacional, sem credenciais reais incluídas.

## 6 — Kubernetes local com kind

Pré-requisitos: Docker funcionando, `kind`, `kubectl`. Rode na raiz:

```bash
kind create cluster --name solvia
docker build -t solvia-serviceops:dev .
kind load docker-image solvia-serviceops:dev --name solvia
kubectl apply -k infra/kubernetes/overlays/local
kubectl -n solvia rollout status deployment/solvia --timeout=180s
kubectl -n solvia get pods,pvc,svc
kubectl -n solvia port-forward svc/solvia 3100:80
```

Acesse http://localhost:3100 enquanto `port-forward` estiver aberto. A instância kind precisa de StorageClass padrão capaz de provisionar o PVC de 2 GiB. O deployment usa `startupProbe`, `readinessProbe`, `livenessProbe`, requests/limits, processo não-root, filesystem somente leitura, `emptyDir` para `/tmp`, PVC e `Recreate`.

Para limpeza **somente do laboratório:** `kind delete cluster --name solvia` (apaga o armazenamento desse cluster). Não reutilize essa instrução no ambiente corporativo.

### Produção Kubernetes

Em `infra/kubernetes/overlays/production` substitua domínio no Ingress + `BASE_URL`, imagem GHCR e tag/digest. Crie o TLS Secret, instale Ingress controller e configure acesso ao GHCR. Crie Secret, sem gravá-lo no Git:

```bash
kubectl -n solvia create secret generic solvia-secrets \
  --from-literal=ENTRA_TENANT_ID='seu-tenant' \
  --from-literal=ENTRA_CLIENT_ID='seu-app-id' \
  --from-literal=ENTRA_CLIENT_SECRET='seu-segredo' \
  --from-literal=BOT_APP_ID='id-do-bot' \
  --from-literal=BOT_APP_PASSWORD='segredo-do-bot' \
  --from-literal=BOT_TENANT_ID='seu-tenant'
```

O namespace precisa existir primeiro (`kubectl apply -f infra/kubernetes/base/namespace.yaml`). Evite `--from-literal` em histórico de shell: **em ambiente real, use secret manager/External Secrets ou arquivos protegidos**, e RBAC mínimo. A sincronização AD/Entra requer consentimento administrativo Microsoft conforme `docs/INTEGRACOES-MICROSOFT.md`.

Antes de `kubectl apply -k infra/kubernetes/overlays/production`, confirme capacidade do cluster, classe de armazenamento, restrição de egress necessária ao Microsoft Graph/Bot Connector, autenticação, DNS/TLS, backups externos e política para bloquear `/internal/metrics` na borda.

**Não usar `replicas: 2`, HPA ou deployment azul/verde com escrita SQLite simultânea.** `Recreate` gera intervalo de indisponibilidade no upgrade. Para HA, migre a persistência e sessões para serviços compartilhados e reprojete concorrência.

## 7 — AWS EC2 com Terraform (OPCIONAL, COM COBRANÇA)

**Aviso de custos:** Terraform criará EC2, disco EBS, IPv4 público e outros componentes que podem ser cobrados. Não há garantia de Free Tier. A região padrão é `sa-east-1` (São Paulo), que pode custar mais que outras regiões. Verifique preços no console e configure alertas AWS Budgets antes de executar.

Pré-requisitos: Terraform CLI >=1.6, AWS CLI/perfil com autorização IAM, conta AWS, domínio e DNS.

```bash
cd infra/terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edite região e instance_type segundo seu orçamento e arquitetura.
terraform fmt -recursive
terraform init
terraform validate
terraform plan -out=plan.tfplan
# Inspecione detalhadamente recursos e valores ANTES de prosseguir.
terraform apply plan.tfplan
terraform output
```

O módulo cria VPC/subnet/IGW/rotas, Security Group com **somente 80/443 de entrada (sem SSH público)**, EC2 Ubuntu 24.04, EBS criptografado, instância com IMDSv2 e IAM Instance Profile com `AmazonSSMManagedInstanceCore`. Cloud-init instala Docker + Compose. A app **não** é implantada automaticamente nem recebe credenciais no Terraform.

Acesse EC2 > Connect > Session Manager (requer IAM do operador, SSM Agent e conectividade de rede, teste se aparece como managed node). A partir do host:

1. Copie/clone seu repositório privado em `/opt/solvia` usando um método corporativo de acesso (nenhum token no `user_data`).
2. Crie `.env.production` em local restrito a administradores, com as informações de `docs/INTEGRACOES-MICROSOFT.md`. Não salve em Git.
3. Aponte DNS **A** ao IP público retornado pelo Terraform e aguarde propagação. O IP pode mudar no stop/start da instância; use DNS/endereçamento estável apropriado em produção.
4. Abra 80/443 externamente e execute no host:

```bash
docker compose --env-file .env.production -f compose.production.yaml up --build -d
docker compose --env-file .env.production -f compose.production.yaml ps
docker compose --env-file .env.production -f compose.production.yaml logs -f proxy app
```

5. Verifique https://seu-dominio/api/ready, login Microsoft e o webhook Teams. A certificação TLS automática do Caddy precisa de DNS válido, porta 80/443 e domínio público.
6. Configure backup **fora** da EC2 (p.ex. S3 criptografado, com política de acesso específica), alertas, retenção e testes de restauração. Nenhum upload ao S3 está ligado por padrão.

**Desmontar laboratório AWS após terminar (evita cobranças):** na pasta `infra/terraform/aws`, após fazer cópias externas: `terraform destroy`. Confirme os recursos removidos no console e note que exclusão de EBS implica perda de dados sem backup.

## 8 — Azure AD e Teams na cloud

O aplicativo **não conecta sozinho** no tenant. Para integrar:

- App Registration single-tenant no **Microsoft Entra ID**; `User.Read` delegado e `User.Read.All` de aplicação com aprovação admin.
- Sincronização de contas pelo Graph: inclui `accountEnabled` (ativo/inativo). AD local exige sincronização para Entra ID; não há LDAP direto.
- Azure Bot habilitado para Teams com webhook HTTPS em `/api/teams/messages` e instalação pessoal do bot.
- Colaborador abre ticket conversando com o bot e técnico responde pelo painel; a resposta retorna ao chat pessoal via referência de conversa armazenada.
- Observar que conta inativa bloqueia entrada, bot e atribuições conforme regras do portal.

Detalhes completos e limitações: `docs/INTEGRACOES-MICROSOFT.md`.

## 9 — Segurança, SRE e responsabilidades antes de produção

- Execute análise de ameaças e pentest; inspecione permissões, CSRF, origem, XSS, sessões e payloads do Teams.
- Configuração de segredos em Azure Key Vault/AWS Secrets Manager (esta base usa variáveis e secrets do Kubernetes).
- Remova toda autenticação de demonstração (`DEMO_MODE=false`) e cadastre primeiro administrador via procedimento documentado.
- Configure backups **offsite**, restauração testada, alerta de falha de backup e RPO/RTO definidos pelo negócio.
- Monitore disponibilidade/erros/recursos e integre notificação de plantão via Alertmanager ou canais apropriados.
- Monitore vulnerabilidades, rotação de credenciais Microsoft, logs sem PII e política LGPD de retenção.
- Crie ambiente staging separado e janela de implantação; GitHub Deploy workflow exige revisão humana.
- **Principal limitação:** SQLite monolítico não oferece HA/multirréplica e a arquitetura não possui workers independentes.

## 10 — Arquitetura e fluxo

```text
 Microsoft Entra ID/Graph       Microsoft Teams/Azure Bot
             \                        /
              \ OAuth / Graph / Webhook
               v                    v
       +--------------------------------------+
       |       Solvia ServiceOps (Node 22)    |
       | SPA + API + SSE + RBAC + métricas     |
       +--------------------------------------+
                         |
                 SQLite WAL + PVC
                         |
                  Backup VACUUM INTO
                         |
                   Cópia OFFSITE(*)

 GitHub -> CI/Testes -> Docker build -> Trivy -> GHCR
                                            |
                               deploy controlado (aprovação)
                                            |
                                Kubernetes / EC2 + Caddy
                                            |
                             Prometheus -> Grafana / Alertas

(*) É responsabilidade do operador implantar armazenamento externo.
```

**Situação da entrega:** arquivos, sintaxe YAML, integração local Node e backup foram testados; build Docker/Kubernetes/Terraform só podem ser executados e validados completamente em ambientes onde as ferramentas e credenciais estejam disponíveis. Não há deployment cloud ou Teams real efetuado por esta entrega.
