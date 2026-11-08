# Segurança e configuração

- Nunca envie .env, segredos OAuth, tokens ou chaves para o GitHub.
- Use HTTPS em produção.
- Configure armazenamento persistente e protegido para banco de dados e sessões.
- Configure ROLE_RANKS_JSON com os níveis numéricos reais das funções do grupo Roblox.
- MIN_PROMOTER_RANK deve ser o nível Roblox correspondente a Aspirante a Oficial, após conferência no grupo.
- O backend consulta o grupo Roblox antes de aceitar cada promoção e usa a identidade da sessão para registrar o responsável.
- Esta base ainda precisa de revisão de segurança, hospedagem, política de privacidade e testes antes de uso oficial.
- A consulta pública de funções do grupo pode mudar; acompanhe a documentação Roblox e avalie migrar para Open Cloud autenticado.

## Limite funcional atual

O endpoint de promoção valida e grava o registro, mas não altera a função do membro no grupo Roblox. A próxima integração deve usar os endpoints oficiais de associação e atribuição de função do Open Cloud, com permissão group:write concedida pelo responsável do grupo. Não habilite alterações reais de função até testar o fluxo em ambiente controlado.
