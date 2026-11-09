# EB Caxias — EB Manager

Portal web de gestão da comunidade do Exército Brasileiro no Roblox.

- **Aplicação:** EB Manager
- **Identidade institucional:** EB Caxias
- **Grupo Roblox:** 241982252
- **Site:** https://eb-manager-rafael1.onrender.com
- **Tecnologias:** Node.js 22, Express 5, PostgreSQL, HTML, CSS e JavaScript.

## Estrutura atual

### Portal público
- Apresentação institucional EB Caxias.
- Acesso ao fluxo OAuth do Roblox.
- Seções de recursos e indicadores de referência da comunidade.
- Layout responsivo para desktop e celular.

### Painel autenticado
- Visão geral com indicadores e atividade recente.
- Perfil da conta Roblox.
- Hierarquia cadastrada no frontend.
- Consulta de membros do grupo (requer chave Open Cloud com leitura).
- Registro de promoções, treinamentos e promoções negadas.
- Histórico de operações.
- Menu, formulários e áreas de acesso especial.

### Acessos especiais
O arquivo `public/access.js` adiciona a área de acessos especiais. O servidor valida os códigos e mantém o nível de acesso na sessão Roblox.

- ADM: operações autorizadas de atribuição de patente.
- CGEx: operações autorizadas de rebaixamento e retorno à patente inicial.
- Criador: permissões especiais e gerenciamento da lista interna de WL.

As operações de patente usam a Roblox Open Cloud e precisam de chave e mapeamentos válidos. A WL é uma lista interna do EB Manager; não substitui as permissões do Roblox.

## Persistência e backend

O backend usa PostgreSQL para:
- Sessões de login (`connect-pg-simple`).
- Histórico de promoções.
- Registros de treinamento, CPD e promoções negadas.
- Solicitações/operações administrativas.
- Lista interna de WL.

As tabelas são criadas pelo servidor na inicialização. O endpoint `/api/health` verifica a conexão com o banco.

## Variáveis de ambiente

Configure no serviço web do Render. Nunca coloque segredos no HTML, JavaScript público ou neste repositório.

| Variável | Finalidade |
|---|---|
| `DATABASE_URL` | URL do PostgreSQL |
| `SESSION_SECRET` | Segredo de sessão com pelo menos 32 caracteres |
| `BASE_URL` | URL HTTPS pública do serviço |
| `ROBLOX_REDIRECT_URI` | Callback OAuth; normalmente `BASE_URL/auth/roblox/callback` |
| `ROBLOX_CLIENT_ID` | Identificador do aplicativo OAuth Roblox |
| `ROBLOX_CLIENT_SECRET` | Segredo OAuth Roblox |
| `ROBLOX_GROUP_ID` | ID do grupo; padrão `241982252` |
| `ROBLOX_OPEN_CLOUD_API_KEY` | Chave Open Cloud com permissões necessárias para o grupo |
| `ROLE_RANKS_JSON` | JSON que associa nomes exatos das patentes aos ranks reais |
| `ROLE_IDS_JSON` | JSON que associa nomes exatos das patentes aos IDs reais das funções |
| `MIN_PROMOTER_RANK` | Rank mínimo para promover; o backend procura Aspirante em ROLE_RANKS_JSON primeiro |
| `MIN_RECORD_RANK` | Rank mínimo para criar registros administrativos |
| `ADMIN_ACCESS_CODE` | Código privado do acesso ADM |
| `CGEX_ACCESS_CODE` | Código privado do acesso CGEx |
| `CREATOR_ACCESS_CODE` | Código privado do acesso Criador |

Os nomes e valores de `ROLE_RANKS_JSON` e `ROLE_IDS_JSON` devem corresponder exatamente às funções existentes no grupo. Não use valores de exemplo em produção. A chave Open Cloud deve pertencer ao responsável autorizado e ter somente os escopos necessários para as operações habilitadas.

## Desenvolvimento local

Requisitos: Node.js 22 e PostgreSQL.

```bash
npm install
npm start
```

O servidor lê as variáveis de ambiente do ambiente de execução ou de um arquivo `.env` local. Não envie o arquivo `.env` ao GitHub.

## Verificações antes de liberar uma versão

1. Confirmar que o deploy do Render terminou com sucesso.
2. Consultar `/api/health` e verificar a conexão com PostgreSQL.
3. Testar login e logout Roblox.
4. Confirmar a associação ao grupo e o nome/rank retornado.
5. Testar permissões com contas de níveis diferentes.
6. Testar promoção, rebaixamento e demais operações somente em ambiente autorizado e com dados de teste.
7. Confirmar que cada alteração aparece no histórico.
8. Conferir as telas em celular e desktop.

## Limitações conhecidas / itens que exigem validação

- Os números da landing page (membros, visitas, favoritos e patentes) são valores de referência apresentados visualmente; ainda não devem ser tratados como métricas sincronizadas em tempo real.
- O fluxo de verificação por biografia Roblox não está implementado como etapa separada neste backend; o login atual é OAuth Roblox e a checagem de associação ao grupo.
- A página pública ainda precisa receber páginas/rotas próprias para Ranking de Instrutores e Constituição, caso esses conteúdos devam ser publicados neste portal.
- A rota protegida de indicações precisa ser conferida no produto final; não se deve presumir que existe apenas porque uma URL foi especificada.
- O deploy mais recente precisa ser confirmado no painel do Render. Um commit no GitHub, sozinho, não comprova que a versão está ativa no site.

## Segurança

- Não compartilhe tokens, chaves Open Cloud, segredos OAuth, códigos de acesso ou conteúdo de `.env`.
- Não publique credenciais em issues, capturas de tela ou mensagens.
- Revise as permissões do grupo e os mapeamentos antes de habilitar operações que alterem patentes.
- Mantenha o histórico de auditoria e teste primeiro com operações controladas.
