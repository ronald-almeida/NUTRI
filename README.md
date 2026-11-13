# NUTRI — Checkout Pix

Checkout do produto **Black Vitalícia | Felipe Almeida**, com valor fixo de **R$ 287,00** e pagamento por Pix.

## Executar

Node.js 24 e pnpm. Instale com `pnpm install --frozen-lockfile`, copie `.env.example` para `.env.local` e configure a chave secreta da Atlas Pags. Para cobrança local, defina `STORE_URL` com o endereço HTTPS do checkout.

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
- Cadastre `ATLAS_SECRET_KEY` como Secret em Production e Preview. A chave `atlas_sk_...` fica somente no servidor.
- `STORE_URL` é opcional na Vercel: a origem HTTPS do próprio checkout é usada por padrão.
- Alterar variáveis exige novo deploy.

## Integração Atlas Pags

Documentação: <https://atlaspags.com/docs/>. A API usa `https://atlaspags.com/api/v1` e autenticação `Authorization: Bearer ATLAS_SECRET_KEY`.

- `POST /charges` cria uma cobrança Pix com `amount: 287`, `method: pix`, descrição, `checkout_url` e os dados `customer.name`, `email`, `document` e `phone`.
- O checkout fixa o valor em 28.700 centavos no servidor. O ID da cobrança, o valor, o método e o código Pix retornados são conferidos antes da exibição.
- `GET /charges/{id}` consulta o estado. O servidor valida ID, valor e método, e só confirma quando a Atlas retorna `paid`.
- O QR code é gerado localmente a partir de `pix.code`; a cobrança vence conforme `pix.expires_at` quando esse campo vem preenchido.
- A página envia `Idempotency-Key` e reutiliza a mesma chave em novas tentativas da mesma cobrança.

O navegador valida os dados, abre o modal, solicita o Pix ao backend e exibe QR code, valor e Copia e Cola. Consulta o status a cada 6 segundos enquanto o modal estiver aberto. Não há checkout de cartão, boleto, parcelamento, cupom, Apple Pay ou moeda alternativa.

O servidor valida CPF e dados do comprador, rejeita requisições de outra origem e entrega uma referência assinada para consultar apenas aquela cobrança. Não registra dados pessoais nem chaves em logs. A confirmação visual não entrega conteúdo automaticamente; o acesso ao curso permanece sob operação do vendedor.

## Validação

Os testes usam fixtures locais; não chamam a Atlas Pags, não criam cobranças e não efetuam pagamentos. Um pagamento real só deve ser considerado homologado após validação com a conta do vendedor.
