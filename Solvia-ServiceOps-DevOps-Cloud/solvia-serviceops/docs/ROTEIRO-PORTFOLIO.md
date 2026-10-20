# Laboratório de portfólio DevOps + Cloud com projeto real

O diferencial deste laboratório é trabalhar em cima de um sistema existente com chamados, usuários, ativos, autenticação e integrações Microsoft — não de uma página Hello World.

## Fase 1: engenharia da aplicação

- Rodar no Windows sem Docker, levantar fluxo de login/ticket/inventário.
- Executar `npm run check` e `npm test` (testes de RBAC, criação de chamado e backup).
- Confirmar health/readiness e métricas protegidas.
- Evidências: resultado dos testes, README de instalação e arquitetura atual.

## Fase 2: containerização e dados persistentes

- Build multi-stage Docker e `docker compose up -d --build`.
- Simular reinicialização `docker compose restart app`; conferir que tickets continuam no volume.
- Executar backup online e restaurá-lo em ambiente de laboratório separado.
- Evidências: Dockerfile, Compose, `docker compose ps`, prints do app e restauração validada.

## Fase 3: CI/CD e supply chain

- Subir repositório privado/público GitHub **sem segredos**.
- Abrir Pull Request propositalmente com teste falhando, observar CI bloquear merge e corrigir.
- Verificar Trivy, commit aprovado, imagem GHCR com tag SHA e SBOM.
- Configurar GitHub Environment com aprovação e fazer deploy **apenas após preparar cluster**.
- Evidências: CI verde, histórico da PR, digest da imagem, controle de aprovação e rollback testado.

## Fase 4: Kubernetes

- Subir cluster kind local, aplicar overlay local por Kustomize.
- Inspecionar Deployment, PVC, requests/limits, probes e logs.
- Simular falha de container e observar auto-recuperação sem perda do volume.
- Publicar versão nova; verificar estratégia `Recreate` e indisponibilidade breve planejada.
- Evidências: `kubectl get pods,pvc,svc`, `describe pod`, readiness, histórico de release.

## Fase 5: observabilidade/SRE

- Inicializar Prometheus + Grafana e acompanhar dashboard provisionado.
- Simular requisição 404/erros em laboratório; analisar métricas e alertas.
- Gerar ticket e conferir variação de `solvia_open_tickets`.
- Registrar postmortem simples: sintoma, causa raiz, mitigação e prevenção.
- Evidências: dashboard, queries PromQL e runbook.

## Fase 6: Terraform + AWS opcional

- Executar somente `terraform init/validate/plan` sem provisionar até revisar custo.
- Com orçamento autorizado, aplicar VPC, rede e VM EC2 com IAM SSM e EBS cifrado.
- Implantar Compose com HTTPS; avaliar TLS, DNS, login Microsoft e Teams somente com aprovação do tenant.
- Demonstrar teardown (`terraform destroy`) após backups e evidência de custos.
- Evidências: `terraform plan`, diagrama de infraestrutura, print de recursos e custo diário estimado.

## Aprendizados e próximos desafios

Os principais trade-offs para defender em entrevista: **SQLite limita HA e multi-réplicas**, credenciais Microsoft são segredos externos, imagens precisam de política de vulnerabilidades, observabilidade requer canal de notificação, backup no mesmo host não cobre desastre, rollout controlado diminui risco e AWS tem custo. Próximas evoluções possíveis: PostgreSQL + migrações, workers para envio Teams, fila resiliente, OpenTelemetry, IaC com remote state, autenticação OIDC no CD e testes de carga/resiliência.
