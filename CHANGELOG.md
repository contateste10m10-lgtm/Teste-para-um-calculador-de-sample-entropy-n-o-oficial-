# Histórico de versões

## V0.9 — Fusão científica + recursos V0.8

- Preservada a interface e a galeria multifonte da versão V0.8, incluindo aba de colagem de URL, biblioteca Swift-BAT/NASA, análise temporal, controles de zoom, histogramas, heatmaps e gráficos por classe.
- Adicionado `analysis-core.js` para centralizar Sample Entropy e índice de modulação intrínseco.
- A análise principal e a SampEn temporal passaram a usar o mesmo núcleo científico.
- Adicionado cálculo do índice de modulação intrínseco por banda, utilizando a coluna de incerteza selecionada e reportando pontos excluídos por erro ausente/inválido.
- Adicionados gráfico independente de modulação, métrica média por bandas válidas e exportação PNG específica.
- Ampliada a tabela e exportação CSV para incluir SampEn, A/B, variâncias observada/ruído/intrínseca, índice de modulação e estados de qualidade.
- Incluídos testes automáticos e GitHub Actions para testar o núcleo e verificar a ligação entre HTML e JavaScript.
- A validação automatizada cobre dados sintéticos. A equivalência completa com EntropyHub v2.0 e a validação com arquivos reais Swift-BAT continuam pendentes.

## V0.8

- Removidos os painéis e números pré-carregados; o site funciona como laboratório independente, orientado aos dados que a pessoa importa.
- Adicionados controles de zoom, redefinição de escala e download PNG em cada gráfico Chart.js; controles próprios para ampliar/reduzir as células do heatmap.
- Incluído zoom por roda/pinça e seleção por arraste quando o plugin do navegador carregar; os botões manuais continuam disponíveis como alternativa.
- Ampliado o cálculo de Sample Entropy temporal para janelas de 100, 200, 300, 500, 800 e 1000 pontos.
- Otimizada a contagem de pares por ordenação na primeira coordenada, mantendo os mesmos A/B do cálculo de referência nos testes sintéticos.
- Incluídos indicador de progresso e cancelamento entre janelas no cálculo temporal.
- Substituído o corte fixo da tabela nos primeiros 100 registros por paginação (100, 250, 500 ou todos); os gráficos e exportações continuam usando todos os registros válidos.
- Mantidas as galerias de histogramas, distribuições sobrepostas por classe, perfis por banda, rankings por fonte, heatmaps, séries temporais, dispersões, gráficos de bolhas e sobreposição de curvas brutas.

## v0.10 — Navegação avançada dos gráficos
- Adicionados controles por gráfico para abrir/fechar visualização ampliada em tela cheia.
- Adicionado arraste para mover a área visível do gráfico, com botão para ativar/desativar.
- Adicionado botão de reset para restaurar a visualização/zoom.
- A navegação também é aplicada a gráficos criados dinamicamente nas galerias e análises em lote.
- Tecla Escape fecha a visualização ampliada.
