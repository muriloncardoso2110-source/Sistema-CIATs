# Checklist de preparação para produção

> NÃO coloque dados reais na demonstração como se o ambiente já estivesse homologado.

- [ ] Definir dono técnico e responsável de negócio do service desk.
- [ ] Definir política de classificação, confidencialidade e retenção de chamados.
- [ ] Executar `npm test` e `npm run check` antes da publicação.
- [ ] Colocar Node LTS em servidor dedicado com disco persistente, monitoramento e atualização de segurança.
- [ ] Configurar HTTPS público e proxy reverso (não expor porta do app diretamente).
- [ ] Definir `DEMO_MODE=false`, `NODE_ENV=production` e `BASE_URL=https://...`.
- [ ] Não transportar o banco SQLite da demonstração para produção, ou excluir de maneira controlada todos os dados fictícios com o serviço parado antes de iniciar.
- [ ] Registrar o aplicativo Graph, conceder `User.Read` e `User.Read.All` e realizar consentimento de administrador.
- [ ] Validar leitura de usuários ativos **e inativos** de uma amostra real.
- [ ] Configurar usuário corporativo administrador usando `server/cli.mjs` após primeiro login Microsoft.
- [ ] Revisar papéis: somente equipe aprovada pode acessar tickets de terceiros.
- [ ] Criar Azure Bot, habilitar Teams, publicar `api/teams/messages` com TLS e instalar app no escopo pessoal.
- [ ] Testar abertura pelo Teams, resposta pelo portal e entrega de volta ao mesmo chat.
- [ ] Testar erro de entrega, expiração de segredo, ausência do bot e conta desativada.
- [ ] Evitar credenciais no repositório; proteger `.env`, aplicar rotação e usar cofre quando possível.
- [ ] Validar backup SQLite, integridade e **restauração** com desligamento coordenado ou snapshots adequados.
- [ ] Revisar textos de privacidade/termos com DPO e jurídico, com adequação à LGPD.
- [ ] Fazer avaliação de pentest, revisão de código e política de logs.
- [ ] Definir janela de manutenção, monitoramento, runbook e contingência.
- [ ] Reavaliar uso de SQLite/um processo se volume, requisitos de HA ou concorrência crescerem.

A disponibilização em produção está sujeita à aprovação da equipe responsável pela infraestrutura, segurança da informação e governança do tenant.

## Verificações DevOps adicionais

- [ ] Fazer `npm test` (inclui `tests/devops.test.mjs`: backup online, métricas, SIGTERM).
- [ ] Verificar no CI vulnerabilidades Docker, render Kustomize e Terraform plan antes de aprovar.
- [ ] Definir e validar DNS/TLS + URL de retorno OAuth e do bot Teams.
- [ ] Confirmar que `/internal/metrics` não é acessível externamente (e exige token forte).
- [ ] Implantar backup fora do host, criptografia, monitoramento do job e simulação de restauração.
- [ ] Implantar processo de aprovação GitHub Environment e segredos com permissão mínima.
- [ ] Reforçar que SQLite permite **uma instância escritora**, replica=1, estratégia Recreate no Kubernetes.
- [ ] Configurar alertas Prometheus com Alertmanager/contatos reais, pois alertas sem receptor não notificam.
- [ ] Configurar IAM, AWS Budgets e revisar custo de EC2/EBS/IPv4 antes do Terraform apply.
- [ ] Verificar que os Secrets Microsoft são somente leitura pela aplicação e não constam de Git/logs.
