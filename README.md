# Multiband Entropy Lab

Aplicação estática em HTML/CSS/JavaScript para explorar curvas de luz multibanda e calcular Sample Entropy (SampEn) separadamente em até oito bandas de energia.

## Funcionalidades


- Importa arquivos locais de texto ASCII `.lc`, `.txt`, `.csv`, `.tsv`, `.fits` e `.gz` (gzip com descompactação nativa ou `pako` como fallback).
- Oferece três abas de importação: arquivo local, link direto e Biblioteca NASA/Swift-BAT.
- Na aba **Colar link**, aceita uma URL HTTP(S), tenta importar o arquivo e tem um botão que tenta baixá-lo de forma explícita (fetch → Blob → download). A Biblioteca NASA também tenta salvar diretamente a curva `.lc.gz`. Se o servidor de origem bloquear CORS, o navegador não permite forçar o download por código; nesse caso, clique com o botão direito no link e escolha “Salvar link como…”, ou salve pela página de origem e use a aba **Arquivo local**.
- Na **Biblioteca NASA**, abre o catálogo oficial e prepara o link direto da curva snapshot de oito bandas para um nome Swift.
- Sugere o mapeamento de tempo, taxa/fluxo e erro para cada banda; a seleção é sempre ajustável manualmente.
- Calcula SampEn para cada banda com dimensão `m` selecionável e tolerância `r × σ` (padrão `m = 2`, `r = 0,2σ`).
- Mostra tabela de resultados, um gráfico de SampEn por banda e oito gráficos de curvas de luz.
- Exporta uma tabela CSV de resultados e o gráfico de comparação em PNG.
- Processa os arquivos localmente no navegador; não envia os dados importados a um servidor.

## Importante sobre os dados Swift-BAT

O Swift-BAT 157-month survey publica curvas de luz snapshot com taxas em oito bandas de energia, além de uma banda total. A aplicação tenta reconhecer tanto arquivos ASCII quanto FITS binários com tabela BINTABLE. Em tabelas FITS ela reconhece colunas TIME/MJD e vetores RATE/RATE_ERR, incluindo vetores FITS de comprimento variável P/Q, e os expande em colunas de bandas. Os downloads do catálogo são tentados por fetch/Blob para acionar a gravação local; se o servidor não permitir acesso por CORS, use “Salvar link como…” no link oficial. Confira sempre o mapeamento de colunas: a detecção automática é uma sugestão, não uma garantia sobre a organização de todos os arquivos.

Para arquivos Swift-BAT, a convenção sugerida é 14–20, 20–24, 24–35, 35–50, 50–75, 75–100, 100–150 e 150–195 keV. Para outros instrumentos, os nomes aparecem como Banda 1…Banda 8 e podem ser editados diretamente no formulário antes da análise.



## V0.7 — Galeria completa de visualizações

Esta versão amplia o site estático para incluir estilos de gráficos do projeto Python, sem fabricar observações ausentes.

### Gráficos com uma curva multibanda carregada

- Sample Entropy calculada por banda (barras).
- Oito curvas de luz em painéis separados.
- **Sobreposição das oito curvas de luz** no mesmo eixo; a normalização z-score pode ser ativada para comparar formas quando as escalas diferem.
- **Sample Entropy temporal por janelas**, sobreposta por banda. O tamanho da janela e o passo podem ser escolhidos; o cálculo usa a ordem dos pontos válidos e reporta janelas sem SampEn finita como indisponíveis.

### Gráficos a partir do CSV/TSV de resultados do Python

A seção **Galeria multifonte** pode importar os resultados exportados pelo Python com mapeamento de colunas. Os gráficos possíveis, conforme os campos disponíveis, são:

- Histograma global da SampEn, usando cada registro ou a média por fonte.
- Histogramas sobrepostos por classe, com bins comuns.
- Perfil da SampEn média por banda, primeiro calculando a média de cada fonte × banda e depois dando peso igual a cada fonte.
- Ranking comparativo da SampEn média por fonte.
- Heatmap fonte × banda, com média das janelas disponíveis em cada célula.
- Dispersão SampEn × variabilidade robusta.
- Dispersão SampEn × índice de modulação intrínseco (eixos logarítmicos; só pares positivos).
- **Gráfico de bolhas**: SampEn × variabilidade, com tamanho definido por uma terceira coluna quantitativa selecionada pelo usuário.
- **Sobreposição de curvas de luz de duas fontes** na mesma banda, quando o CSV tiver uma linha por ponto e colunas reais de fonte, banda, tempo e fluxo/RATE.
- Evolução temporal da SampEn por janela, com bandas sobrepostas para a fonte selecionada.
- Tabela de auditoria dos registros importados e exportação CSV dos dados lidos.

Exemplos de formatos aceitos:

Resultados fonte × janela × banda:

```csv
fonte,janela,banda,sampen,classe_fonte,variabilidade_robusta,modulation_index_percent,n_pontos
SWIFT_A,1,band_1,1.82,BZQ,0.24,18.5,200
SWIFT_A,1,band_2,1.91,BZQ,0.26,19.1,200
```

Curvas de luz brutas em formato longo para sobreposição entre fontes:

```csv
fonte,tempo,banda,fluxo
SWIFT_A,147235851,band_1,0.000012
SWIFT_A,147930620,band_1,0.000016
SWIFT_B,147235851,band_1,0.000009
SWIFT_B,147930620,band_1,0.000011
```

Os exemplos acima são **apenas modelos de formato**, não dados observacionais. Substitua-os por registros reais exportados da sua análise. Para o gráfico de bolhas, mapeie uma terceira variável quantitativa real (por exemplo, número de pontos válidos); o site não inventa uma dimensão para preencher o gráfico.

### Cuidados científicos

- `m` da Sample Entropy (dimensão de embedding) **não** é o índice de modulação intrínseco. As colunas são separadas no site.
- A dispersão SampEn × índice de modulação exige uma coluna real de índice de modulação; a SampEn não é usada como substituta.
- O histograma por registro é descritivo. Quando a tabela contém várias janelas por fonte, elas não são observações independentes para inferência populacional. Escolha **Média por fonte** quando o objetivo for comparar objetos.
- Heatmap e perfil por banda fazem a agregação por fonte × banda antes da comparação.
- O ajuste logarítmico só inclui valores positivos. Casos ausentes ou não positivos não são substituídos por zeros.
- A sobreposição de curvas brutas requer que tempo, fluxo e unidades sejam comparáveis. O gráfico preserva as unidades importadas e não remove automaticamente outliers nem corrige exposição.
- Todos os arquivos importados são processados no navegador; não são enviados a um servidor.

## Método e limitações

O cálculo usa distância de Chebyshev, exclui auto-pares (`i < j`) e calcula `SampEn = -ln(A/B)`, em que `B` é o número de pares de padrões de comprimento `m` dentro de `r` e `A` o número desses pares que também correspondem no ponto seguinte. O desvio padrão e a tolerância são calculados por banda. Se `A = 0`, não há valor finito reportado: o resultado aparece como indisponível em vez de ser substituído por zero.

Sample Entropy trabalha com a ordem dos pontos, e não pondera automaticamente os intervalos reais entre datas. Para curvas com cadência irregular, lacunas, exposições diferentes ou poucos pontos, interprete os resultados com cautela. Esta versão não corrige automaticamente efeitos de exposição ou incertezas; as colunas de erro são lidas apenas para transparência futura e não entram diretamente na fórmula de SampEn.

A opção demonstrativa gera dados sintéticos para testar a interface; não são dados observacionais.

## Como testar localmente

1. Descompacte o projeto.
2. Abra `index.html` em um navegador moderno. Para evitar restrições de navegador, também pode usar uma extensão de servidor local do VS Code.
3. Clique em **Explorar dados demonstrativos** para experimentar, importe um arquivo local ou abra **Colar link** para inserir uma URL HTTP(S). Confirme o mapeamento de colunas antes de analisar.
4. Se a importação/download pela URL falhar por CORS, clique com o botão direito no link e escolha **Salvar link como…**, depois selecione o arquivo na aba **Arquivo local**.

Chart.js é carregado via CDN, então a conexão à internet é necessária para renderizar os gráficos.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub, por exemplo `multiband-entropy-lab`.
2. Envie `index.html`, `styles.css`, `app.js`, `README.md` e `.nojekyll` para a raiz da branch `main`.
3. Abra **Settings → Pages**.
4. Em **Build and deployment**, escolha **Deploy from a branch**, branch `main`, pasta `/(root)`, e salve.
5. Aguarde a publicação e abra a URL indicada na página de Settings → Pages.

O site é estático; não precisa de servidor Python ou Node em produção.

## Fontes de dados

- [Catálogo NASA Swift-BAT 157 meses (1.888 fontes)](https://swift.gsfc.nasa.gov/results/bs157mon/)

- [Swift-BAT 157-month survey products](https://swift.gsfc.nasa.gov/results/bs157mon/)
- [Exemplo de curva de luz snapshot de oito bandas](https://swift.gsfc.nasa.gov/bat_survey/bs157mon/8band_snapshot_lc/BAT_157m_eight_band_snapshot_SWIFT_J0010.5%2B1057.lc.gz)


## V0.6 — Figuras do artigo e importação de catálogo individual

O painel **Do artigo às figuras** inclui dois gráficos-resumo montados exclusivamente a partir das médias e desvios-padrão transcritos do pôster:

- Sample Entropy média ± DP para FSRQs (N=511), BL Lacs (N=70) e AGNs (N=25);
- índice de modulação médio ± DP para FSRQs (12,8 ± 8,5%) e BL Lacs (17,0 ± 10,4%).

Esses painéis reproduzem os **resumos publicados**, não os pontos individuais do catálogo. O histograma OVRO original e a dispersão individual SampEn × índice de modulação não podem ser reconstruídos fielmente a partir de uma imagem e estatísticas-resumo. Para gerar essas figuras a partir dos dados, carregue um CSV/TSV com uma linha por fonte, idealmente com as colunas:

```csv
source,class,sampen,modulation_index_percent
```

- `source`: identificador/nome da fonte (opcional);
- `class`: classe óptica (opcional);
- `sampen`: valor individual de Sample Entropy (necessário para o histograma);
- `modulation_index_percent`: índice de modulação intrínseco em porcentagem (necessário para a dispersão SampEn × m).

O painel mapeia as colunas manualmente quando os nomes são diferentes. Os gráficos gerados incluem histograma da SampEn, dispersão log–log SampEn × m, comparação de médias ± DP por classe e estatísticas de correlação calculadas dos registros importados. Os pares com valores não positivos de SampEn ou m não entram na dispersão log–log. Não use a coluna `m` de parâmetro de embedding da SampEn como se fosse o índice de modulação: são grandezas diferentes.

Todos os dados importados continuam no navegador. O repositório GitHub Pages contém o código; ele não contém, por padrão, os 721 registros individuais OVRO. Para reproduzir exatamente as figuras do pôster, obtenha a tabela observacional individual usada no estudo.
