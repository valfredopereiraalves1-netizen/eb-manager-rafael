# EB Manager — Exército Brasileiro

Painel web inicial para gestão do grupo Roblox **[EB] Exército Brasileiro Manager do Rafael**.

## Grupo
- ID do grupo Roblox: `241982252`

## Como visualizar
Abra `index.html` no navegador ou publique o repositório com o GitHub Pages.

## Módulos incluídos na versão inicial
- Visão geral
- Hierarquia inicial editável no código
- Registro de promoções e histórico
- Ranking de treinamentos
- CPD
- Registro de promoções negadas
- Administração e exportação CSV dos logs

## Importante
Esta é uma primeira interface funcional de demonstração. Os registros ficam somente no armazenamento local do navegador e não sincronizam entre dispositivos. Ainda não há autenticação segura, banco de dados, integração oficial com Roblox nem validação de permissões no servidor. **Não use esta versão para decisões administrativas oficiais nem coloque senhas ou códigos de acesso no HTML/JavaScript público.**

Antes da publicação oficial, será necessário implementar backend, autenticação, banco de dados e validação das permissões no servidor. A hierarquia inicial deve ser revisada para corresponder exatamente aos cargos e patentes oficiais do grupo.

## Backend em preparação

Foi adicionado um backend Node.js com:
- Login Roblox OAuth 2.0 com state e PKCE.
- Sessões com cookie HttpOnly, SameSite e Secure em produção.
- Verificação da associação e da função do usuário no grupo Roblox 241982252.
- API de promoções que verifica no servidor a permissão do promotor, a patente atual do militar e a patente de destino.
- Banco SQLite para os registros de promoção.

**Limite atual:** o backend registra uma promoção validada, mas ainda não altera automaticamente a função do membro dentro do grupo Roblox. Para isso, falta integrar a operação oficial de atribuição de função do Open Cloud, com autorização `group:write` concedida pelo responsável do grupo. A interface antiga já chama a API para registrar promoções quando a sessão está ativa.

### Configuração necessária antes de executar
1. Instale Node.js 20 ou superior.
2. Copie .env.example para .env e configure as variáveis sem publicar o arquivo.
3. Cadastre/configure o aplicativo OAuth Roblox e use exatamente o callback definido em ROBLOX_REDIRECT_URI.
4. Preencha ROLE_RANKS_JSON com os níveis reais das funções do grupo e MIN_PROMOTER_RANK com o nível correspondente a Aspirante a Oficial.
5. Execute npm install e npm start.

O cadastro/publicação de aplicativos OAuth Roblox exige os requisitos de elegibilidade definidos pela Roblox. Não tente contornar verificações de idade ou identidade; o responsável autorizado deve cuidar dessa etapa.

O backend ainda não está hospedado. Não use em produção até concluir configuração, integração da atribuição real de função via Open Cloud, revisão de segurança e testes.

## Tecnologias
HTML, CSS, JavaScript, Node.js, Express e SQLite.


## Banco de dados PostgreSQL no Render

A versão atual usa PostgreSQL para persistir promoções, treinamentos, CPD, promoções negadas e sessões de login. O serviço precisa receber estas variáveis de ambiente:

- `DATABASE_URL`: URL interna do banco PostgreSQL criado no Render.
- `SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres.
- `BASE_URL`: URL HTTPS pública do serviço.
- `ROBLOX_REDIRECT_URI`: `BASE_URL` seguido de `/auth/roblox/callback`.
- `ROBLOX_CLIENT_ID` e `ROBLOX_CLIENT_SECRET`: credenciais OAuth criadas no portal oficial do Roblox.
- `MIN_PROMOTER_RANK` e `MIN_RECORD_RANK`: ranks mínimos do grupo Roblox para promover e registrar dados administrativos. Ajuste aos ranks reais do grupo.
- `ROLE_RANKS_JSON`: JSON com o nome exato de cada patente do painel e o número de rank correspondente no grupo Roblox.

O servidor cria as tabelas necessárias na primeira inicialização. Os formulários de treinamento, CPD e promoção negada exigem login Roblox e token CSRF. A promoção também exige o mapeamento correto dos ranks reais; não preencha esses valores por estimativa.


## Acessos especiais adicionados

A interface agora inclui uma área **Acessos especiais** com validação dos códigos no backend (os códigos não ficam no HTML nem no JavaScript público). Configure no painel Environment do Render:

- `ADMIN_ACCESS_CODE`: código privado do painel ADM.
- `CGEX_ACCESS_CODE`: código privado do painel CGEx.
- `CREATOR_ACCESS_CODE`: código privado do painel do Criador.

Use os valores combinados pelo responsável do projeto e não os publique no GitHub. Os três valores devem ser configurados como variáveis de ambiente no serviço web.

### O que esta etapa faz

- Valida o código no servidor e guarda o nível de acesso na sessão autenticada do Roblox.
- ADM/Criador podem registrar solicitações para definir patente.
- CGEx/Criador podem registrar solicitações de rebaixamento ou revogação.
- Criador pode administrar a lista de WL do painel.
- Solicitações administrativas e WL são guardadas no PostgreSQL.

### O que ainda não está concluído

As solicitações de patente, rebaixamento e revogação ficam **pendentes para auditoria**; esta etapa ainda não altera automaticamente cargos no grupo Roblox. A integração de escrita precisa de uma chave Open Cloud configurada no Render com escopo `group:write`, além de validação de hierarquia e testes com o grupo correto. O login OAuth Roblox também precisa estar configurado. Não trate o painel como sistema oficial até terminar esses passos.

A hierarquia visual já está no site, mas os nomes/ranks reais precisam ser conferidos com a configuração do grupo. Configure `ROLE_RANKS_JSON`, `MIN_PROMOTER_RANK` e `MIN_RECORD_RANK` com os valores reais antes de liberar promoções.
