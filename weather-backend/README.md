# CLOUDGOD — motor meteorológico multifonte

Este pacote acrescenta um backend Python ao painel HTML. O navegador pede a análise ao servidor; o servidor consulta e processa os dados.

## Fontes usadas

- **NOAA/NCEP GFS 0,25° via NOMADS:** descarrega recortes GRIB2 do ponto escolhido e extrai temperatura a 2 m, humidade, pressão ao nível do mar, precipitação, CAPE/CIN e vento em níveis selecionados. O GFS aqui é determinístico.
- **CPTEC/INPE:** consulta a previsão local oficial de 7 dias por latitude/longitude (serviço XML do CPTEC). A previsão diária do CPTEC é exibida separadamente da amostragem horária do GFS.
- **INMET:** consulta o catálogo público de estações automáticas e identifica a estação operante mais próxima. A leitura horária exige credencial/token do INMET; sem token, o boletim informa que encontrou a estação mas não conseguiu obter a observação.

## Iniciar no Windows

1. Instale Python 3.11 ou 3.12.
2. Extraia a pasta `CLOUDGOD_backend`.
3. Abra `start_windows.bat`.
4. Aguarde a instalação. Quando o servidor iniciar, deixe a janela aberta.
5. Abra o `CLOUDGOD_gerador_analise_meteorologica.html` no mesmo computador e gere o JPEG.
6. Verifique o servidor em `http://127.0.0.1:8765/api/health`.

## Iniciar no Linux/macOS

```bash
./start_linux_mac.sh
```

Se `pygrib` não instalar no seu sistema, use Docker (há um Dockerfile incluído).

## INMET

O catálogo de estações pode ser consultado sem token. Para observações horárias, solicite a credencial oficial ao INMET e configure a variável de ambiente `INMET_TOKEN` antes de iniciar o servidor. Não coloque o token no HTML nem o publique.

Linux/macOS:

```bash
export INMET_TOKEN='SEU_TOKEN'
./start_linux_mac.sh
```

Windows PowerShell:

```powershell
$env:INMET_TOKEN='SEU_TOKEN'
py -m uvicorn server:app --host 127.0.0.1 --port 8765
```

## Executar num servidor/VPS

O HTML usa por padrão `http://127.0.0.1:8765` para testes locais. No Render, antes dos scripts do painel defina:

```html
<script>window.CLOUDGOD_API_BASE = "https://SEU-DOMINIO";</script>
```

Use HTTPS, limite CORS ao domínio do painel e proteja o serviço com autenticação/rate limiting antes de o expor publicamente. O CORS está aberto por padrão apenas para facilitar testes locais.


## Publicar no Render (Docker)

1. Envie a pasta `CLOUDGOD_backend` para um repositório GitHub.
2. No Render, escolha **New → Blueprint** e conecte o repositório. Selecione o ficheiro `render.yaml` dentro da pasta do backend (ou crie um Web Service Docker com essa pasta como Root Directory).
3. O Render fará o build usando o `Dockerfile`. O serviço usa automaticamente a variável `PORT` do Render e verifica `/api/health`.
4. Depois do deploy, copie o endereço HTTPS atribuído, por exemplo `https://cloudgod-weather-api.onrender.com`.
5. No HTML, antes dos scripts da aplicação, configure `window.CLOUDGOD_API_BASE` com esse endereço. Exemplo:

```html
<script>window.CLOUDGOD_API_BASE = "https://SEU-SERVICO.onrender.com";</script>
```

6. Depois de conhecer o domínio do site/painel, substitua `CORS_ORIGINS=*` pelo domínio exato do painel (sem barra no fim), para restringir quem pode chamar a API. Configure `INMET_TOKEN` em **Environment** no Render, se tiver credencial oficial. Nunca coloque esse token no HTML ou no GitHub.

**Nota:** o `render.yaml` declara o plano `starter`; confirme os custos e a disponibilidade do plano na sua conta antes de criar o serviço. O primeiro build pode demorar devido ao `eccodes`/`pygrib`.

## Endpoints

- `GET /api/health`
- `GET /api/geocode?city=Itaquaquecetuba`
- `GET /api/analysis?lat=-23.48&lon=-46.35&city=Itaquaquecetuba%2C%20SP`

## Limitações científicas importantes

- O GFS é uma previsão determinística. A precipitação prevista em mm **não é uma probabilidade percentual de chuva**. O boletim marca a probabilidade como não calculada em vez de inventar um percentual. Para obter probabilidade estatística será necessário integrar membros de um ensemble (por exemplo, GEFS) e definir o limiar de precipitação.
- CAPE e CIN são os campos disponibilizados pelo modelo, não uma sondagem observada. O cisalhamento 0–6 km é uma aproximação calculada com vento de 850 e 500 hPa, não uma integração vertical contínua.
- O boletim só exibe valores que foram retornados e decodificados. Ausência de campo aparece como `—`.
- A estação INMET pode estar distante do ponto. A distância é exibida; uma observação não representa automaticamente todo o município.
- A amostragem GFS usa saídas de 3 horas inicialmente e intervalos maiores após 24 h. A resolução espacial do modelo é 0,25°; o ponto mais próximo da grade não é uma medição exata no endereço.
- A disponibilidade e o tempo de resposta dos servidores NOAA, INMET e CPTEC podem variar. Falhas são sinalizadas no boletim.

## Créditos e atribuição

Os produtos CPTEC/INPE devem ser identificados com a fonte CPTEC/INPE. Verifique os termos de uso do INPE antes de redistribuir ou publicar produtos derivados. NOAA/NCEP NOMADS é identificado como fonte do GFS. INMET é identificado como fonte das observações/estações.
