# Conversor de Extratos

Ferramenta web 100% client-side (processamento integral no navegador, **zero envio de arquivos a servidores**) para converter, conciliar, categorizar e auditar extratos bancários brasileiros em **PDF** (texto nativo, protegidos por senha ou digitalizados via OCR), **OFX**, **CSV**, **TXT** e **XLSX**.

## Principais Funcionalidades (v2.0)

1. **Leitura Multi-Bancos e Multi-Formatos (`PDF`, `OFX`, `CSV`, `XLSX`)**
   - Detecção automática de instituição financeira (**Caixa Econômica Federal, Banco do Brasil, Itaú, Bradesco, Santander, Nubank, Banco Inter, Sicoob, Sicredi, C6 Bank, Cora, BTG Pactual, Safra, Banrisul, Mercado Pago, PagBank**).
   - Suporte a datas completas (`DD/MM/AAAA`), datas curtas sem ano (`DD/MM` com inferência automática do ano de competência pelo cabeçalho, padrão Itaú/Bradesco) e cabeçalhos de data por extenso (`18 SET 2026`, padrão Nubank/Inter).
   - Suporte completo a sufixos e sinais bancários: `D`/`C` (mesmo em blocos separados no PDF), `(-)`/`(+)` (Banco do Brasil), `1.250,00-` (Itaú), `-R$ 250,00`, parênteses contábeis e colunas separadas `Débito` / `Crédito`.
   - Desbloqueio local de **PDFs protegidos por senha** (CPF/CNPJ) e **OCR otimizado** (`Tesseract.js` com reuso de Web Worker e botão de cancelamento).

2. **Conciliação Matemática Automática de Saldos**
   - Extrai automaticamente o `Saldo Anterior` do PDF (ou infere matematicamente pelo primeiro saldo reportado) e confere dia a dia se `Saldo Inicial + Créditos - Débitos = Saldo Informado no PDF`.
   - Sinaliza imediatamente qualquer divergência diária (`Dif: R$ X,XX`) e oferece botão rápido `⇄` para inverter `Débito ⇄ Crédito` em 1 clique.

3. **Deduplicação Inteligente entre Períodos Sobrepostos**
   - Remove automaticamente lançamentos duplicados ao consolidar PDFs com períodos sobrepostos, preservando tarifas ou Pix idênticos legítimos ocorridos no mesmo dia dentro do mesmo extrato.

4. **Categorização Contábil Automática, Regras Salvas e Edição em Lote**
   - Classificação automática com sugestão de **Categoria** e **Conta Contábil**.
   - Motor de **Regras Personalizadas** persistidas no navegador + **Localizar e Substituir em Lote** no histórico + **Desfazer (`Ctrl+Z`)** + rascunho automático local.

5. **Exportação Profissional Multi-Formato**
   - **Excel (`.xlsx`)**: Modelo **Contábil** (`Data | Débito | Crédito | Histórico`) ou **Auditoria Completa** (`12 colunas + 4 abas`: *Lançamentos*, *Resumo Mensal*, *Por Categoria* e *Conciliação Diária* com fórmulas `SUM`, autofiltro e formatação BRL).
   - **OFX Universal (`.ofx`)**: Pronto para importação direta em **Domínio Sistemas, Alterdata, Contmatic, Fortes, SCI, Conta Azul, Omie e Nibo**.
   - **CSV (`.csv`)**: UTF-8 com BOM (`;`), abre diretamente no Excel em Português com acentuação intacta.

---

## Como Executar Localmente

```bash
npm install
npm test
npm run dev
```

## Publicação Automática

- **GitHub Pages** (já configurado em `.github/workflows/deploy.yml`):
  1. Envie os arquivos para a branch `main` em `github.com/ademirvarjao/conversorbancario`.
  2. Em **Settings → Pages → Build and deployment**, selecione **Source: GitHub Actions**.
  3. O site ficará publicado automaticamente em `https://ademirvarjao.github.io/conversorbancario/`.
- **Vercel / Netlify / Cloudflare Pages**:
  - Importe o repositório `ademirvarjao/conversorbancario` diretamente (os arquivos `vercel.json` e `netlify.toml` já configuram `npm run build` e `dist` automaticamente).
