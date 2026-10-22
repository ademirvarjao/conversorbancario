# TODO — Conversor de Extrato Bancário

## Importação e consolidação de documentos
- [x] O aplicativo aceita o envio simultâneo de vários PDFs por arrastar e soltar ou seleção de arquivos, mostra a lista dos documentos carregados, permite remoção individual e suporta a consolidação de vários meses em uma única planilha.
- [x] O processamento ocorre prioritariamente no navegador, sem enviar os dados bancários a serviços externos, preservando a privacidade durante leitura, revisão e exportação.

## Leitura adaptativa de extratos
- [x] O aplicativo lê extratos de diferentes bancos e modelos novos com análise adaptativa baseada no layout e nos cabeçalhos, usando o extrato da Caixa como referência principal sem limitar o suporte a esse formato.
- [x] Quando há mais de uma coluna de data, o aplicativo identifica automaticamente a coluna de data mais apropriada por posição e rótulo, priorizando movimento/efetivação/transação e evitando vencimento quando houver alternativa.
- [x] O aplicativo identifica os lançamentos e ignora cabeçalhos, rodapés, títulos, paginação e demais textos que não correspondam a lançamentos bancários.
- [x] O aplicativo identifica descrições quebradas em várias linhas e as unifica em uma única linha, preservando corretamente os espaços entre palavras.
- [x] A tabela consolidada contém, no mínimo, as colunas Data, Valor, Histórico e Saldo, acrescenta Documento quando disponível e preserva os sinais positivo e negativo de créditos e débitos.

## Qualidade e revisão
- [x] O aplicativo detecta e remove duplicidades causadas por páginas repetidas, arquivos duplicados ou períodos sobrepostos, usando chave exata e referência por data/documento/valor.
- [x] O aplicativo acompanha o processamento com progresso, contadores de arquivos e lançamentos e indicação clara de erros ou PDFs que precisem de atenção.
- [x] O aplicativo oferece uma etapa de conferência e ajustes em tabela antes do download, com alertas visuais para linhas de baixa confiança e bloqueio de exportação para dados inválidos.

## Exportação e experiência
- [x] O aplicativo exporta a base consolidada nos formatos XLSX e CSV, com colunas numéricas e datas úteis para planilhas.
- [x] A interface é clara, em português do Brasil, inspirada em uma ferramenta técnica moderna de conferência tabular, com contraste suave, acentos verde-água para progresso e validação e baixa fadiga visual.

## Evidência de validação

A versão entregue foi compilada com `pnpm build`, teve diagnósticos TypeScript registrados e foi testada no navegador com `EXTRATOCAIXASET26.pdf`: 17 páginas, 414 lançamentos, históricos “PAGAMENTO GAS DO POVO”, “DEPOSITO CHEQUE CAIXA AG” e “DESBLOQ CHEQUE DEPOSITADO” reconstruídos, documento 31422 como `-12555.84` com saldo `13421.68`, e download real de `extrato-consolidado.xlsx` confirmado.
