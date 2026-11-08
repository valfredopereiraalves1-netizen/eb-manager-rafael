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
