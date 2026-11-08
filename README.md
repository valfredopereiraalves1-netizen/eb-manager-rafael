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


## Integração Open Cloud e hierarquia

A API de alteração de função foi ligada ao backend usando a operação oficial **Assign Role Group Membership** da Roblox Open Cloud. O serviço não executa alterações enquanto as configurações abaixo estiverem ausentes.

Configure no Render (Environment), nunca no GitHub:

- `ROBLOX_OPEN_CLOUD_API_KEY`: chave criada pelo proprietário/responsável autorizado do grupo, com acesso ao grupo correto e escopo `group:write`.
- `ROLE_IDS_JSON`: objeto JSON que associa cada nome exato de patente usado no painel ao ID real da função Roblox. Exemplo de formato (substitua os valores de exemplo pelos IDs verdadeiros):
  `{"[ASP] Aspirante a Oficial":"ID_REAL","[REC] Recrutamento":"ID_REAL"}`
- `ROLE_RANKS_JSON`: objeto JSON com os nomes exatos das patentes e seus níveis/ranks reais para validar a ordem hierárquica.
- `MIN_PROMOTER_RANK`: rank real mínimo de Aspirante a Oficial.
- `MIN_RECORD_RANK`: rank mínimo para criar registros administrativos.
- `ADMIN_ACCESS_CODE`, `CGEX_ACCESS_CODE`, `CREATOR_ACCESS_CODE`: códigos definidos pelo responsável, mantidos apenas como variáveis privadas do serviço.

O formulário normal de promoção verifica a patente atual real do membro, exige destino acima da patente atual e impede que o promotor promova alguém para patente igual ou superior à dele. Em seguida tenta atribuir a função via Open Cloud e só então grava o log.

O painel ADM aplica a patente escolhida. O painel CGEx calcula rebaixamento para a patente imediatamente inferior e revogação para a patente de entrada configurada como menor rank. O painel do Criador também gerencia a WL. Essas ações exigem a chave e os mapeamentos reais; a API da Roblox também pode recusar a ação se a chave não tiver autorização suficiente.

**Atenção:** confirme com o responsável pelo grupo o significado operacional de “revogação” antes de usar essa opção; no código, ela foi definida como retorno à patente inicial, sem expulsar o membro do grupo. A WL deste painel é uma lista administrativa interna; não controla por si só o login Roblox.
