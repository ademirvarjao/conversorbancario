# Conversor de Extratos

Aplicação web client-side com **Agente de I.A. & Memória Evolutiva de Layouts** para leitura, conciliação e conversão de extratos bancários brasileiros (**PDF, OFX/QFX, CSV/TXT e XLSX/XLS**) para **Excel Contábil (`.xlsx`), OFX Conciliável (`.ofx`) e CSV (`.csv`)**.

- **Site publicado:** [https://ademirvarjao.github.io/conversorbancario/](https://ademirvarjao.github.io/conversorbancario/)

## Principais Recursos

- **Interface Direta e Objetiva**: tela limpa focada diretamente na conversão, conciliação e exportação contábil (`Data`, `Documento`, `Histórico`, `Débito`, `Crédito` e `Saldo PDF`).
- **Agente de I.A. com Aprendizado Contínuo (`IndexedDB` + `LocalStorage`)**:
  - Cataloga automaticamente cada modelo de layout de extrato que passa pelo site (impressão digital de cabeçalho, clusterização de coordenadas X das colunas numéricas, formato de data e convenção de sinal).
  - **Evolução Automática**: toda vez que um sinal é invertido (`⇄`), uma linha de subtotal/ruído é excluída (`×`), um saldo divergente é auto-corrigido ou uma instrução é enviada ao Agente em linguagem natural, o padrão é gravado permanentemente no modelo daquele banco e aplicado automaticamente nos próximos extratos.
  - **Solucionador Combinatório de Divergências**: identifica e corrige automaticamente sinais invertidos ou subtotais intrusos comparando contra o saldo oficial do PDF.
  - **Backup / Compartilhamento de Memória (`.json`)** + Conector opcional para **Google Gemini, OpenAI ou OpenRouter** para extratos atípicos complexos.
- **Privacidade Total**: processamento local no navegador com suporte a PDFs protegidos por senha e OCR local.

## Desenvolvimento e Build

```bash
npm install
npm test
npm run build
```
