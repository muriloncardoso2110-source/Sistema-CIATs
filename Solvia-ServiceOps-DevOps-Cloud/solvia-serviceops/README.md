# Solvia ServiceOps — Service Desk + Gestão de TI

**Uma plataforma de atendimento corporativo com design próprio, interface responsiva, operação local sem Docker e uma camada adicional de DevOps & Cloud.**

O projeto é uma aplicação real de frontend + API + banco de dados, com dados de demonstração para testar a experiência. Possui pontos de integração implementados para Microsoft Entra ID e Teams, que só funcionam com as credenciais, permissões e publicação corporativa descritas neste guia.


## DevOps & Cloud (nova camada de engenharia)

O mesmo sistema agora vem preparado para containerização, CI/CD, provisionamento em nuvem, operação Kubernetes e observabilidade. **Não precisa de Docker para usar a aplicação normalmente.**

| Recurso | Arquivos | Finalidade |
|---|---|---|
| Docker multi-stage e Compose | `Dockerfile`, `compose.yaml` | Laboratório com container não-root, healthcheck e volume persistente |
| HTTPS corporativo | `compose.production.yaml`, `infra/Caddyfile` | Proxy Caddy, domínio e TLS automático |
| GitHub Actions | `.github/workflows/` | Testes, scan Trivy, GitHub Container Registry e deploy manual aprovado |
| Kubernetes | `infra/kubernetes/` | Kustomize local/produção, probes, PVC, limites e isolamento básico |
| AWS Terraform | `infra/terraform/aws/` | VPC, subnet, regras de rede, EC2, IAM SSM, EBS criptografado |
| Prometheus + Grafana | `infra/compose.observability.yaml`, `infra/prometheus/`, `infra/grafana/` | Métricas autenticadas, dashboards e regras de alerta |
| Backup consistente | `scripts/backup.mjs`, `scripts/backup-scheduler.mjs` | VACUUM INTO com teste de integridade, retenção e agendamento single-host |
| Segurança de implantação | `.dockerignore`, secrets/roles/probes | Menor privilégio, variáveis externas, `Recreate` com SQLite |

**Comece pelo [Guia DevOps & Cloud](docs/DEVOPS-CLOUD.md)**. Inclui passo a passo desde Windows sem Docker até AWS Terraform e Kubernetes. Recursos AWS podem gerar custos; as integrações Microsoft exigem credenciais e permissões reais. A camada IaC não torna a plataforma automaticamente distribuída ou pronta para produção.

## Comece aqui no Windows (sem nada instalado)

1. **Instale o Node.js 22.13 ou superior** (prefira uma versão LTS atual): https://nodejs.org/.
2. Extraia o arquivo ZIP para uma pasta, por exemplo `C:\Projetos\Solvia-ServiceOps`.
3. Abra a pasta com o VS Code, se desejar.
4. Clique duas vezes em **`INICIAR-WINDOWS.bat`**. Ele cria o arquivo `.env` a partir do `.env.example`, se necessário, e abre o navegador.
5. Acesse **http://localhost:3100**.
6. Clique em um perfil de demonstração e entre com a senha **`Solvia@2026`**.

Em Linux/macOS, execute `cp .env.example .env` e `npm start` dentro da pasta.

### Logins do ambiente de demonstração

| Perfil | Login | Senha |
|---|---|---|
| Administrador | admin@solvia.local | Solvia@2026 |
| Suporte | suporte@solvia.local | Solvia@2026 |
| Colaborador | colaborador@solvia.local | Solvia@2026 |

Outros dados de demonstração, como chamados e equipamentos, são **fictícios**. O usuário inativo `inativo@solvia.local` não pode autenticar.

## Recursos incluídos

| Módulo | Principais recursos |
|---|---|
| Painel | Métricas, categorias, gráfico mensal, chamados recentes, filtros por perfil |
| Chamados | Abertura, fila, pesquisa, situação, prioridade, grupo, técnico, histórico e conversa |
| Microsoft Teams | Endpoint de bot autenticado, abertura por chat, mensagens Teams → Portal e respostas Portal → Teams |
| Colaboradores | Contas ativas e inativas, departamento, unidade, papel, sincronização Entra ID |
| Ativos | Cadastro, usuário responsável, situação, garantia, transferências, histórico e software por equipamento |
| Estoque | Categorias, saldo, mínimo, entradas, saídas, destinatário e rastreabilidade |
| Software | Cadastro de sistemas, licença, validade, número contratado e instalações por equipamento |
| Relatórios | Indicadores e exportação CSV dos chamados |
| Administração | Estado das integrações, controle de papéis, trilha de auditoria |
| Segurança | Sessões HttpOnly, scrypt para senhas de demo, CSRF, perfis, bloqueio de conta inativa, validação JWT Teams |

**O que depende de configurar a infraestrutura real:** autenticação Microsoft, sincronização do diretório, publicação HTTPS do bot e troca efetiva de mensagens com colaboradores pelo Teams. **Não estão implementados:** integração LDAP direta com AD puramente local, anexos de arquivos, envio de notificações por e-mail, mecanismo de backup automatizado, SSO invisível no Teams e SLA com calendário de feriados/expediente. O campo `due_at` usa horas corridas (4h crítica, 8h alta, 24h média, 72h baixa) na criação pelo portal.

## Como usar a plataforma

**Chamados:** em `Central de chamados`, filtre por situação, grupo ou responsável, busque o número e abra o detalhe. Agentes atribuem, respondem ou encerram; colaboradores visualizam somente seus chamados.

**Equipamentos:** em `Parque tecnológico`, cadastre o patrimônio; entre no item para associá-lo a um colaborador, mudar situação e vincular sistemas. A transferência é registrada no histórico.

**Estoque:** em `Estoque e acessórios`, crie o tipo de item e movimente `Entrada` ou `Saída`. O sistema impede saída acima do saldo disponível.

**Diretório:** um administrador pode atribuir papéis. Não é possível conferir papel de suporte a pessoas inativas ao atribuir um chamado. A sincronização pelo Graph exige permissões aprovadas.

## Estrutura do projeto

```text
solvia-serviceops/
├── INICIAR-WINDOWS.bat        # Duplo clique para executar
├── .env.example               # Configuração de referência
├── package.json               # Scripts Node nativos, sem dependências de terceiros
├── public/
│   ├── index.html             # Interface web
│   ├── app.js                 # Componentes e interação
│   ├── style.css               # Design system responsivo / claro / escuro
│   └── privacy.html, terms.html
├── server/
│   ├── index.mjs              # API, autenticação, autorização, eventos SSE
│   ├── db.mjs                 # SQLite, tabelas, dados fictícios iniciais
│   ├── integrations.mjs       # Entra ID, OAuth e bot Teams
│   ├── config.mjs             # Variáveis do ambiente
│   └── cli.mjs                # Promoção do primeiro administrador real
├── tests/platform.test.mjs    # Testes integrados com banco isolado
├── scripts/gerar-teams.mjs    # Manifest do aplicativo Teams
├── teams-app/                 # Ícones e manifesto gerável
├── docs/                      # Instalação corporativa, arquitetura e checklist
└── data/                      # Banco local gerado automaticamente (ignorado pelo git)
```

## Comandos úteis

```bash
npm start          # inicia o servidor
npm run dev        # reinicia ao alterar backend
npm run check      # valida sintaxe JS
npm test           # roda testes integrados com banco temporário
```

## Dados, manutenção e segurança

- O banco é gerado em `data/solvia.sqlite`. Para fazer backup manual, **pare o servidor** e copie esse arquivo para um lugar protegido; restaure com o serviço parado. SQLite utiliza WAL durante a execução, portanto não copie só o `.sqlite` com o serviço ligado.
- Para zerar a **demonstração**, pare o servidor e apague os arquivos `data/solvia.sqlite*`; na próxima execução, os dados fictícios serão recriados. **Nunca execute isto em produção.**
- Não envie o arquivo `.env` a outras pessoas. Ele terá segredos Microsoft quando as integrações forem ativadas.
- Defina `DEMO_MODE=false`, `NODE_ENV=production`, `BASE_URL=https://seu-dominio` e contas corporativas antes da implantação; o login local de demonstração é bloqueado nesse modo.
- O servidor utiliza `node:sqlite`. O Node 22 pode mostrar um aviso experimental na inicialização; recomenda-se manter uma versão LTS atual e validar compatibilidade antes de atualizar.
- Esta entrega é um **projeto funcional e extensível**, não uma certificação de prontidão para produção. Antes de dados reais, faça avaliação de segurança, pentest, LGPD, backup, restauração, monitoramento, retenção e alta disponibilidade.

**Leia também:** [`docs/DEVOPS-CLOUD.md`](docs/DEVOPS-CLOUD.md), [`docs/INTEGRACOES-MICROSOFT.md`](docs/INTEGRACOES-MICROSOFT.md), [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) e [`docs/CHECKLIST-PRODUCAO.md`](docs/CHECKLIST-PRODUCAO.md).
