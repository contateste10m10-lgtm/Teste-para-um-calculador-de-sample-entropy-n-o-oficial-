# Multiband Entropy Lab — V0.9 (fusão científica + recursos V0.8)

Laboratório independente para importar curvas de luz, calcular Sample Entropy (SampEn) e índice de modulação intrínseco por banda, e gerar gráficos exploratórios no navegador. É um site estático, adequado para GitHub Pages: os arquivos importados permanecem no dispositivo do usuário e não são enviados para um backend do projeto.

## Recursos

### Cálculo de Sample Entropy
- Importação local de `.lc.gz`, FITS, `.lc`, `.txt`, `.csv`, `.tsv` e `.dat` (conforme estrutura do arquivo).
- Importação por URL quando o servidor remoto permite CORS; alternativa por download local.
- Mapeamento editável de tempo, taxa/fluxo, erro e oito bandas.
- Dimensão de embedding e tolerância ajustáveis; padrão inicial de SampEn: dimensão de incorporação `m = 2` e `r = 0,2 × σ`. A dimensão `m` da SampEn não é o índice de modulação intrínseco.
- Resultados por banda com SampEn, A/B, índice de modulação intrínseco, contagem de incertezas válidas/excluídas e estados para casos não calculáveis.
- Núcleo científico isolado em `analysis-core.js`, testável sem a interface e usado tanto pela análise completa quanto pela SampEn temporal.
- Curvas de luz individuais e sobreposição das oito bandas, com opção de z-score.
- Sample Entropy temporal em janelas configuráveis de 100, 200, 300, 500, 800 ou 1000 pontos e passo configurável. O cálculo usa busca de candidatos ordenada e permite pedir cancelamento entre janelas.

### Controles dos gráficos
- Zoom por rolagem do mouse e pinça quando o plugin opcional estiver disponível.
- Arraste para selecionar uma região para zoom; `Shift` + arraste permite mover a vista.
- Botões `+`, `−`, `Reset` e `PNG` em cada gráfico; o heatmap tem controles próprios para ampliar/reduzir as células.
- O zoom manual por botões continua disponível mesmo se o plugin de gestos não carregar.

### Gráficos da tabela individual (uma linha por fonte/objeto)
- Histograma global da SampEn.
- Histogramas de SampEn sobrepostos por classe, com bins comuns.
- Dispersão log–log SampEn × índice de modulação intrínseco, incluindo ajuste log–log quando possível.
- Gráfico de bolhas SampEn × modulação com uma terceira variável real selecionada no mapeamento.
- SampEn média ± desvio-padrão por classe.
- Índice de modulação médio ± desvio-padrão por classe, quando disponível.
- Tabela auditável com paginação e exportação dos registros válidos.

### Galeria multifonte (formato longo)
- Histograma global e histogramas sobrepostos por classe.
- Perfil médio de SampEn pelas bandas.
- Ranking/resumo de SampEn por fonte.
- Heatmap fonte × banda.
- Dispersão SampEn × variabilidade robusta.
- Dispersão SampEn × índice de modulação.
- Gráfico de bolhas com uma terceira coluna quantitativa.
- Evolução temporal de SampEn por janela com bandas sobrepostas.
- Sobreposição de curvas de luz brutas de duas fontes na mesma banda.
- Tabelas paginadas; todos os registros válidos seguem disponíveis para os gráficos e a exportação, não apenas a página atualmente visível.

## Formatos de dados

### Tabela individual
Uma linha por fonte/objeto, por exemplo:

```csv
source,class,sampen,modulation_index_percent,bubble_size
OBJETO_A,Classe_A,1.23,12.8,146
OBJETO_B,Classe_B,0.91,17.0,203
```

`source`, `class`, `modulation_index_percent` e `bubble_size` são opcionais conforme o gráfico. O campo `sampen` é obrigatório para a galeria de catálogo. Para o gráfico de bolhas, a terceira variável tem de vir dos dados; não se fabricam valores apenas para preencher o gráfico.

### Tabela multifonte fonte × janela × banda
Uma linha por combinação fonte/janela/banda, por exemplo:

```csv
fonte,janela,banda,tempo,fluxo,sampen,classe_fonte,variabilidade_robusta,modulation_index_percent,n_pontos,snr_media
OBJETO_A,1,band_1,12345,0.0021,1.45,Classe_A,0.32,12.8,200,2.1
```

Os campos de classe, janela, banda, tempo, fluxo, variabilidade, modulação e tamanho de bolha são mapeados separadamente. Os gráficos só são criados quando as colunas necessárias estiverem disponíveis. A dimensão de incorporação da SampEn não é o índice de modulação intrínseco.

Para sobreposição de curvas brutas, forneça linhas por ponto temporal, com fonte, banda, tempo e fluxo/RATE. Um CSV de resultados de SampEn não contém, em geral, todos os pontos necessários para recriar a curva original.

## Publicar no GitHub Pages

1. Extraia o ZIP e envie todos os arquivos e pastas para a raiz do repositório na branch `main` — incluindo `analysis-core.js`, `tests/` e `.github/`, além de `index.html`, `styles.css`, `app.js`, `README.md`, `CHANGELOG.md` e `.nojekyll`.
2. No GitHub, abra **Settings → Pages**.
3. Em **Build and deployment**, selecione **Deploy from a branch**, branch `main` e pasta `/(root)`.
4. Salve, aguarde a publicação e teste os gráficos no endereço fornecido pelo GitHub.

O site não requer servidor Python/Node em produção. O Chart.js e bibliotecas opcionais são carregados por CDN; é necessária conexão para carregar essas bibliotecas. Sem o plugin de zoom, os botões manuais `+`, `−`, `Reset` e `PNG` continuam disponíveis.

## Limitações científicas

- O cálculo deve ser interpretado junto com a cadência, lacunas, unidades, valores inválidos e parâmetros escolhidos.
- Janelas de uma mesma fonte não são automaticamente observações independentes para testes inferenciais.
- O site não inventa intervalos de energia, unidades, métricas de variabilidade ou índice de modulação ausentes do arquivo.
- O índice de modulação intrínseco é calculado localmente a partir da curva e da coluna de incerteza mapeada, conforme a equação do artigo. A SampEn pode ser calculada mesmo quando essa coluna não está disponível; nesse caso, a modulação fica indisponível com status explícito.
- A fórmula de modulação implementada usa variância amostral (divisor N−1), conforme o script Python do projeto; o artigo apresenta a fórmula, mas não explicita o divisor.
- A SampEn segue H_SE = −ln(A/B), distância de Chebyshev, pares não idênticos e tolerância relativa à dispersão da própria banda. A implementação precisa ser validada numericamente contra EntropyHub v2.0 e curvas Swift-BAT reais antes de ser considerada reproduzível em nível de publicação.

## Arquivos

- `index.html`: interface.
- `styles.css`: estilos responsivos.
- `app.js`: importação, interface, gráficos, paginação, análise temporal, biblioteca NASA, exportação e zoom.
- `analysis-core.js`: cálculo de SampEn e índice de modulação intrínseco.
- `tests/`: testes automatizados dos algoritmos e do contrato entre interface e núcleo.
- `.github/workflows/tests.yml`: executa os testes com Node.js em pushes e pull requests.
- `.nojekyll`: evita processamento Jekyll desnecessário em publicação estática.

### Navegação dos gráficos (v0.10)
Cada gráfico possui controles para abrir uma visualização em tela cheia, arrastar para navegar pelos eixos e restaurar o zoom. O botão **Mover** ativa/desativa o arraste; a tecla **Esc** fecha a visualização ampliada. Esses controles são adicionados também aos gráficos dinâmicos.
