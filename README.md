# NUTRI — Checkout Pix

Checkout do produto **Black Vitalícia | Felipe Almeida**, com valor fixo de **R$ 287,00**, somente Pix, baseado na referência informada pelo proprietário.

## Executar

Node.js 24 e pnpm. Instale com `pnpm install --frozen-lockfile`, copie `.env.example` para `.env.local` e preencha a chave privada da Firebot. Para cobrança local, defina `STORE_URL` com o endereço HTTPS do checkout.

```sh
pnpm dev
pnpm test
pnpm build
```

Em ambientes Windows que impeçam processos filhos, execute os testes com `node --test --test-isolation=none test/payment.test.js`.

## Vercel

Projeto: `nutri`, equipe `ronald-almeida-4717s-projects`.

- Framework: Other; Node.js: 24.x.
- Build: `node scripts/build.mjs`; saída estática: `dist`.
- `api/pix.js` e `api/pix-status.js` são funções Node.js da Vercel.
- Cadastre `FIREBOT_API_KEY` como Secret em Production e Preview. A chave não deve ser versionada ou exposta ao navegador.
- `STORE_URL` é opcional na Vercel: a origem HTTPS do próprio checkout é usada por padrão.
- Alterar variáveis exige novo deploy.

## Contrato Firebot

Implementado a partir da documentação autenticada em <https://firebotbr.com/integracoes/docs>, consultada em 13/11/2026:

- `POST https://firebotbr.com/api/v1/pix/create`, autenticação `x-api-key`.
- Valor enviado **em reais**, `amount: 287`, `productType: DIGITAL`, `storeUrl`, descrição e dados `customer.name/email/cpf/phone`.
- Retorno esperado: `success`, `transactionId`, `amount`, `pixCopiaECola`, `status`.
- `GET https://firebotbr.com/api/v1/pix/{transactionId}` consulta o status.
- A página de documentação de consulta não publica um exemplo de resposta. O código aceita objeto direto ou envelope `transaction`/`data`, exige ID e valor correspondentes e só confirma o status `PAID`. Essa resposta precisa ser conferida com uma transação real antes de considerar a conciliação homologada.
- O QR code é renderizado localmente a partir do Pix Copia e Cola da Firebot. O código valida o CRC, BRL e o valor, quando presente no payload Pix.

## Fluxo e limites

O navegador valida os dados, abre o modal, solicita o Pix ao backend e exibe QR code, valor e Copia e Cola. Consulta o status a cada 6 segundos enquanto o modal estiver aberto. Não há checkout de cartão, boleto, parcelamento, cupom, Apple Pay ou moeda alternativa.

O servidor fixa o preço em 28.700 centavos, valida CPF e dados do comprador, rejeita requisições de outra origem e entrega uma referência assinada para consultar apenas aquela cobrança. Não registra dados pessoais nem chaves em logs. O contador aparece apenas se a Firebot informar `expiresAt` — não há prazo fictício.

A documentação não especifica idempotência da criação. Por isso, não há reenvio automático de cobranças. A aba guarda a cobrança gerada em `sessionStorage`, sem os dados pessoais digitados; o modal pode ser reaberto sem gerar outra cobrança. Em resposta incerta ou timeout, novas tentativas são bloqueadas nessa aba e é orientada a conferência com o vendedor. Não há garantia de deduplicação entre dispositivos ou abas: isso exigiria suporte de idempotência confirmado pela Firebot ou armazenamento persistente de pedidos.

A confirmação visual não entrega conteúdo automaticamente. A entrega de acesso ao curso não foi especificada e deve ser feita pelo vendedor. Não foi criado webhook de liberação, pois a consulta direta de status atende ao fluxo solicitado.

## Validação

Os testes usam fixtures locais; não chamam a Firebot, não criam cobranças e não efetuam pagamentos. Cobrem preço fixo, dados inválidos, adulteração do recibo, valor e identidade da transação, CRC do Pix, origem, limite de requisição, falha de rede sem repetição e ausência de chave. Um pagamento real não deve ser informado como testado até concluir a homologação com a conta do vendedor.
