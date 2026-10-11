# Multiband Entropy Lab

Aplicação estática em HTML/CSS/JavaScript para explorar curvas de luz multibanda e calcular Sample Entropy (SampEn) separadamente em até oito bandas de energia.

## Funcionalidades


- Importa arquivos de texto ASCII `.lc`, `.txt`, `.csv`, `.tsv`, `.fits` e `.gz` (gzip com descompactação nativa em navegadores modernos).
- Inclui uma pequena área de acesso à biblioteca oficial NASA/Swift-BAT: abre o catálogo completo, prepara o link direto da curva snapshot para um nome Swift e permite baixar a curva de oito bandas. Depois do download, carregue o arquivo na área de entrada.
- Sugere o mapeamento de tempo, taxa/fluxo e erro para cada banda; a seleção é sempre ajustável manualmente.
- Calcula SampEn para cada banda com dimensão `m` selecionável e tolerância `r × σ` (padrão `m = 2`, `r = 0,2σ`).
- Mostra tabela de resultados, um gráfico de SampEn por banda e oito gráficos de curvas de luz.
- Exporta uma tabela CSV de resultados e o gráfico de comparação em PNG.
- Processa os arquivos localmente no navegador; não envia os dados importados a um servidor.

## Importante sobre os dados Swift-BAT

O Swift-BAT 157-month survey publica curvas de luz snapshot com taxas em oito bandas de energia, além de uma banda total. A aplicação tenta reconhecer tanto arquivos ASCII quanto FITS binários com tabela BINTABLE. Em tabelas FITS ela reconhece colunas TIME/MJD e vetores RATE/RATE_ERR, incluindo vetores FITS de comprimento variável P/Q, e os expande em colunas de bandas. Como os arquivos do catálogo podem ser grandes, o download da NASA ocorre em uma nova aba e o arquivo é então importado localmente. Confira sempre o mapeamento de colunas: a detecção automática é uma sugestão, não uma garantia sobre a organização de todos os arquivos.

Para arquivos Swift-BAT, a convenção sugerida é 14–20, 20–24, 24–35, 35–50, 50–75, 75–100, 100–150 e 150–195 keV. Para outros instrumentos, os nomes aparecem como Banda 1…Banda 8 e podem ser editados diretamente no formulário antes da análise.

## Método e limitações

O cálculo usa distância de Chebyshev, exclui auto-pares (`i < j`) e calcula `SampEn = -ln(A/B)`, em que `B` é o número de pares de padrões de comprimento `m` dentro de `r` e `A` o número desses pares que também correspondem no ponto seguinte. O desvio padrão e a tolerância são calculados por banda. Se `A = 0`, não há valor finito reportado: o resultado aparece como indisponível em vez de ser substituído por zero.

Sample Entropy trabalha com a ordem dos pontos, e não pondera automaticamente os intervalos reais entre datas. Para curvas com cadência irregular, lacunas, exposições diferentes ou poucos pontos, interprete os resultados com cautela. Esta versão não corrige automaticamente efeitos de exposição ou incertezas; as colunas de erro são lidas apenas para transparência futura e não entram diretamente na fórmula de SampEn.

A opção demonstrativa gera dados sintéticos para testar a interface; não são dados observacionais.

## Como testar localmente

1. Descompacte o projeto.
2. Abra `index.html` em um navegador moderno. Para evitar restrições de navegador, também pode usar uma extensão de servidor local do VS Code.
3. Clique em **Explorar dados demonstrativos** para experimentar, ou importe seus dados e confirme o mapeamento de colunas.

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
