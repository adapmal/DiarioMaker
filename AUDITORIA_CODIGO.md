# Auditoria do DiárioMaker

> Atualização em 05/09/2026: parte dos achados de geração e duplicação já recebeu correções. Consulte [ACOMPANHAMENTO_AUDITORIA.md](ACOMPANHAMENTO_AUDITORIA.md) para o estado atual; o texto abaixo preserva a auditoria original.

Data: 04/09/2026. Escopo: código atual do workspace, incluindo alterações locais preexistentes. Nenhum código de produção foi alterado nesta auditoria.

## Conclusão

O aplicativo compila, mas apresenta defeitos relevantes de perda de dados, exposição de arquivos e divergência entre controles da interface e execução. Prioridade imediata: corrigir limpeza de cache, proteção das rotas e persistência antes de ampliar funcionalidades.

## Método e limites

- Leitura de backend, estado/persistência React, componentes, utilitários de imagem, áudio/timecode, configurações e documentação.
- `npm run lint`: passou; este comando executa apenas TypeScript, sem lint de React Hooks ou estilo.
- `npm run build`: passou. Bundle principal: 764,00 kB, 217,72 kB gzip; aviso de chunk acima de 500 kB.
- Reproduções isoladas por Node/VM e esbuild, com filesystem simulado para operações destrutivas. Nenhum projeto, imagem ou backup real foi apagado.
- Não foram chamadas APIs pagas, lidos valores de credenciais, exercitadas rotas de ataque em servidor real ou validados todos os fluxos na interface gráfica.
- Não houve consulta a bases de vulnerabilidades das dependências nem validação externa dos catálogos e parâmetros atuais de modelos. Build aprovado não comprova compatibilidade com provedores.
- Auditoria abrangente por leitura e verificações direcionadas; não constitui prova de ausência de outros erros.

## Achados prioritários

### 1. Crítico — Limpar temporários apaga imagens definitivas e backups

**Evidência:** `src/App.tsx:6353`, `src/App.tsx:6371`, `server.ts:379`.

A interface anuncia limpeza de `projects/<projeto>/cache/`. O servidor remove `session_store.json`, `session_store_autosave.json` e todos os arquivos de `imagens/`. O JSON do projeto continua referenciando as imagens apagadas. Backups globais também são atingidos, independentemente do projeto selecionado.

**Reprodução isolada:** a chamada com filesystem simulado removeu a sessão, o autosave e `imagens/final-image.png`.

**Correção:** separar temporários de ativos persistentes; remover apenas arquivos comprovadamente não referenciados e limitar a operação ao projeto. Conferir status HTTP antes da mensagem de sucesso no cliente.

### 2. Crítico se acessível pela rede — Leitura arbitrária de arquivos e exposição de chaves

**Evidência:** `server.ts:1991`, `server.ts:1220`, `server.ts:95`, `server.ts:3046`.

`stream-local-audio?path=...` aceita caminho arbitrário e transmite os bytes, sem restringir diretório, autorização ou tipo real. O MIME de áudio não impede um cliente HTTP de ler outro tipo de arquivo. `/config` retorna configurações mescladas com as chaves do arquivo de segredos. O servidor escuta em `0.0.0.0`, sem autenticação nas rotas.

**Impacto:** qualquer cliente que consiga alcançar a porta pode acessar arquivos legíveis pelo processo e credenciais configuradas. A exposição externa efetiva depende da rede/firewall, que não foi inspecionada. Mesmo localmente, a aplicação não define uma fronteira de autorização.

**Correção:** usar loopback por padrão, autenticar sessões, limitar arquivos a seleções autorizadas com identificadores opacos e retornar apenas indicadores de presença das chaves.

### 3. Alto — Caminhos não permanecem dentro do projeto

**Evidência:** `server.ts:540`, `server.ts:649`, `server.ts:651`, `server.ts:755`.

`sceneId` entra diretamente no nome do arquivo de imagem. Sequências com separadores e `..` são normalizadas por `path.join` e escapam de `imagens/`. Além disso, `path.basename('..')` continua sendo `..`; usá-lo como única proteção de `folder` não assegura confinamento. A conversão de imagens locais para inlineData também aceita caminhos relativos sem verificar a raiz final.

**Reprodução isolada:** `sceneId='../../../../outside'` resolveu para `C:\Audit\projects\outside_unique.png`, fora da pasta de imagens do projeto. Nenhuma gravação real foi feita.

**Correção:** identificadores de arquivo gerados no servidor, validação estrita de nomes e verificação de contenção do caminho resolvido. Considerar junctions/symlinks na verificação de arquivos existentes.

### 4. Alto — Proxy aceita destinos arbitrários e conteúdo ativo

**Evidência:** `server.ts:637`, `server.ts:665`.

As rotas baixam a URL fornecida pelo cliente sem restringir hosts, endereços privados, redirecionamentos ou tamanho. O proxy ainda repassa o Content-Type remoto, permitindo servir HTML ou SVG ativo sob a origem do aplicativo se a URL for aberta como documento.

**Impacto:** requisições a serviços internos a partir do servidor e possibilidade de executar conteúdo de origem externa sob a origem local. SVG enviado ao save-image também fica disponível como arquivo estático da aplicação.

**Correção:** validar destinos e redirecionamentos; impor timeout e tamanho máximo; verificar/decodificar formatos raster; rejeitar conteúdo ativo ou servi-lo em origem isolada.

### 5. Alto — Falha de gravação retorna sucesso; gravações não são atômicas

**Evidência:** `server.ts:243`, `server.ts:361`, `server.ts:575`.

Se a gravação principal falhar, o servidor tenta um temporário. Se essa segunda tentativa também falhar, apenas registra aviso e retorna sucesso. A primeira tentativa escreve diretamente sobre o arquivo definitivo, podendo truncá-lo em interrupções ou falta de espaço.

**Reprodução isolada:** com todas as gravações lançando `disk full`, a rota de sessão respondeu `{success:true}`.

**Correção:** sempre gravar em temporário e substituir após conclusão; propagar falhas; manter última versão válida e informar ao cliente quais cópias foram efetivamente persistidas.

### 6. Alto — Excluir a última cena não persiste o estado vazio

**Evidência:** `src/App.tsx:1738`, `src/App.tsx:883`, `src/App.tsx:3486`, `src/App.tsx:1880`.

A exclusão atualiza o estado React, mas os dois caminhos de persistência abortam quando a lista fica vazia. A restauração também exige cenas não vazias. Ao recarregar depois da exclusão da última cena, a versão anterior pode voltar. Projetos novos com apenas roteiro também ficam sem persistência física por esse caminho.

**Correção:** distinguir projeto ainda não carregado de projeto legitimamente vazio; salvar e restaurar `scenes: []` como estado válido.

### 7. Alto — Recuperação ignora edições locais mais recentes

**Evidência:** `src/App.tsx:1905` até a seleção de `finalData`.

O código lê `ethos_storyboard_updated_at`, mas não compara versões: sempre prefere dados do servidor quando há cenas. Edições mantidas no navegador durante uma falha de rede são descartadas no reload se existir uma cópia antiga no disco.

**Correção:** resolver versões por ID de projeto e revisão confirmada; preservar a cópia local divergente e oferecer recuperação quando houver conflito.

### 8. Alto — Salvamentos concorrentes podem sobrescrever versões mais novas

**Evidência:** `src/App.tsx:1738`, `src/App.tsx:1808`, `src/App.tsx:1821`, `server.ts:587`.

Cada alteração de cenas ou diversos campos dispara duas requisições com o projeto completo. `/projects/save` já atualiza a sessão global, duplicando a segunda chamada. Não há fila ou rejeição de revisão antiga no servidor. Requisições grandes ou abas simultâneas podem terminar fora de ordem e regravar estado antigo. A persistência IndexedDB também roda sem coordenação entre execuções do efeito.

**Correção:** debounce, uma fila de gravação por projeto e controle de revisão no servidor. O timestamp fornecido pelo cliente não é usado para impedir sobrescrita antiga.

### 9. Alto — A geração ignora modelo Gemini selecionado e imagem de referência

**Evidência:** `server.ts:2785`, `server.ts:2942`.

O servidor recebe `visualInstructionImage`, mas não a utiliza nessa rota. O modelo Gemini é reduzido a dois IDs fixos de Imagen: `nano_banana` escolhe um; qualquer outro valor escolhe o outro. Um ID Gemini explícito vindo do catálogo não chega à chamada de geração.

**Impacto:** controles visuais não correspondem ao processamento, comprometendo fidelidade, rastreabilidade e expectativas de uso de modelos.

**Correção:** despacho explícito por modelo/capacidade e encaminhamento real das referências; rejeitar combinações não suportadas. Este achado independe da disponibilidade atual dos IDs no provedor.

### 10. Alto — Estúdio não envia chave OpenAI para a geração

**Evidência:** `src/components/StoryboardCard.tsx:613`, `server.ts:2802`.

O gerador do estúdio envia apenas `x-gemini-key`. O servidor exige `x-openai-key` para entrar no ramo OpenAI e não recupera a chave salva nessa decisão. Selecione um modelo OpenAI nesse fluxo e a chamada seguirá para o ramo Gemini. O gerador em fila envia cabeçalhos diferentes.

**Correção:** centralizar a escolha de provedor e credenciais no servidor e compartilhar uma única função de geração entre fila e estúdio.

## Outros defeitos e imperfeições

### 11. Médio — Narração de outro projeto pode ser reutilizada

**Evidência:** `src/App.tsx:1336`, `src/App.tsx:1366`.

Na troca de projeto, o carregamento aceita uma URL global como fallback e não limpa o áudio anterior. O efeito de persistência pode gravar essa URL sob o novo nome. As sondagens assíncronas não são canceladas na troca. Um projeto sem áudio próprio pode tocar/exportar a narração anterior.

**Correção:** vincular áudio a ID estável de projeto, zerar o estado na troca e descartar respostas antigas.

### 12. Médio — Seletor de pasta não usa o diretório escolhido

**Evidência:** `server.ts:1949`, `src/App.tsx:3606`, `server.ts:541`.

O servidor retorna caminho completo e nome final. O cliente utiliza apenas o nome, e o salvamento sempre escreve em `cwd/projects/<nome>`. Escolher outra unidade não muda o destino real; nomes iguais colidem. Alterar `projectFolder` também dispara salvamento das cenas atuais na pasta nova.

**Correção:** definir se o controle escolhe um destino ou um projeto. Implementar o caminho autorizado completo ou apresentar claramente que apenas o nome é utilizado.

### 13. Médio — IndexedDB pode anunciar sucesso sem dados duráveis

**Evidência:** `src/lib/cacheStore.ts:85`, `src/App.tsx:1753`, `src/App.tsx:1518`.

Falha na abertura do banco é capturada e a função resolve sem sinalizar falha; o chamador substitui a imagem por `idb://` mesmo assim. A escrita resolve no sucesso da requisição, sem aguardar `transaction.oncomplete` nem tratar abort da transação. Na hidratação, chave ausente vira string vazia.

**Correção:** rejeitar falhas e resolver somente no commit da transação; conservar a imagem original até confirmação e tratar cache ausente como erro recuperável.

### 14. Médio — EDL elimina posições temporais e intervalos

**Evidência:** `src/lib/timecodeUtils.ts:837`, `src/lib/timecodeUtils.ts:874`.

O EDL calcula record-in acumulando durações a partir de zero, em vez de respeitar os horários das cenas. Reprodução: cenas 10–14s e 30–34s viraram 0–4s e 4–8s. Isso perde alinhamento com a narração.

**Correção:** preservar posições na timeline e representar intervalos explicitamente. Validar o arquivo em um editor antes de afirmar compatibilidade integral.

### 15. Médio — Exportação completa pode sair incompleta e com extensões erradas

**Evidência:** `src/App.tsx:4222`, `src/App.tsx:4241`, `src/lib/imageUtils.ts:55`.

Quando a imagem não pode ser obtida, o ZIP completo mantém a referência anterior sem abortar a exportação. Binários são empacotados com `.png` mesmo quando são JPEG/WebP. Separadamente, o helper cria MIME `data:image/png` em vez de `image/png`, confirmado por execução isolada.

**Correção:** relatório de ativos ausentes e falha explícita no modo completo; preservar MIME/extensão reais ou converter o binário.

### 16. Médio — Garantia 16:9 e ausência de URLs externas não é uniforme

**Evidência:** `src/lib/imageUtils.ts:33`, `src/lib/imageUtils.ts:68`, `server.ts:1052`.

O center-crop do SVG está correto. PNG/JPEG/WebP passam pelo download sem redimensionamento: os parâmetros de tamanho não se aplicam a eles. A geração OpenAI retorna URL remota se o download server-side falhar, reintroduzindo dependência de rede/CORS/expiração.

**Correção:** aplicar pipeline explícito de normalização quando a exportação exigir 1920×1080; em falha de materialização da imagem, devolver erro recuperável em vez de referência frágil.

### 17. Médio — Operações síncronas bloqueiam o servidor inteiro

**Evidência:** `server.ts:1946`, `server.ts:1972`, `server.ts:171` e rotas de gravação.

Os seletores usam `execSync` com timeout de 60 segundos; enquanto a janela fica aberta, o event loop não atende outras requisições. JSON de até 500 MB, upload em memória de 250 MB, serialização e filesystem síncronos ampliam consumo de RAM e pausas. O cenário é agravado pelos salvamentos completos frequentes.

**Correção:** processo assíncrono para diálogos; limites menores e específicos; arquivos binários separados do JSON; controle de concorrência e gravação assíncrona.

### 18. Médio — Streaming não valida Range nem erros assíncronos

**Evidência:** `server.ts:2010` até o encerramento da rota.

O parser pressupõe intervalo simples com início numérico. Sufixos, intervalos inválidos e valores além do arquivo não recebem validação adequada. Streams não têm listener de erro; um erro emitido após o try/catch não é capturado por ele e pode encerrar o processo.

**Correção:** implementar semântica de Range/416 e conectar tratamento de erro/fechamento, preferencialmente usando suporte de streaming já consolidado.

### 19. Médio — start não seleciona modo de produção

**Evidência:** `package.json:12`, `server.ts:3027`.

`npm start` executa o bundle, mas não define `NODE_ENV`. Sem configuração externa, o servidor cria middleware Vite em vez de servir o build. A porta também é fixa em 3000, apesar da variável PORT documentada.

**Correção:** tornar modo e porta explícitos, com comportamento consistente entre desenvolvimento, start e executável. Empacotamento EXE não foi executado nesta auditoria.

### 20. Baixo — Timecode pode exibir segundos inválidos

**Evidência:** `src/lib/timecodeUtils.ts:72`.

Reprodução: `formatShortTimecode(59.99)` retorna `00:60.0`, porque arredonda segundos depois de calcular minutos.

**Correção:** arredondar o total em décimos antes de decompor minutos e segundos.

## Manutenibilidade e coerência

- `App.tsx` concentra mais de oito mil linhas, com persistência, credenciais, filas, importação/exportação, áudio e interface. `server.ts` reúne mais de três mil linhas e múltiplas responsabilidades. Recomenda-se extrair serviços e hooks por fluxo, começando por persistência e geração, preservando comportamento com testes de regressão.
- Não foi encontrada suíte automatizada de testes no código do projeto. `test_audio.wav` é um ativo, não um teste executável. Faltam testes de perda de dados, migração, troca de projeto, cache indisponível, Range e import/export.
- TypeScript não habilita `strict`; há uso recorrente de `any` e validação superficial de JSON externo. Imports podem carregar campos com formatos incompatíveis e falhar posteriormente em operações de string/array.
- Chaves de LocalStorage divergem: grupos são gravados como `ethos_connection_groups`, mas o fallback consulta `ethos_storyboard_connection_groups`; modelo de imagem é inicialmente lido como `ethos_openai_dalle_model`, mas um efeito grava `openai_dalle_model`. Isso cria restauração inconsistente.
- Metadados de geração incluem tempos constantes e descrições de resolução não medidas. Não devem ser apresentados como métricas reais.
- A detecção de rosto é uma heurística de cor; objetos com cores semelhantes podem deslocar o foco. O canvas de análise também estica a imagem para 160×90, enquanto a exibição usa recorte, afetando correspondência espacial em imagens fora de 16:9.
- O handover descreve componentes, cache e rotas que não correspondem à árvore atual, além de fallbacks de imagem que já não representam o fluxo executado. Precisa ser atualizado.
- O script clean usa `rm -rf`, sem portabilidade garantida para o ambiente Windows. Build não inclui typecheck, que só passou porque foi executado separadamente.

## Ordem sugerida de correção

1. Impedir exclusão de ativos definitivos e exposição de arquivos/chaves; corrigir confinamento de caminhos e proxy.
2. Corrigir sucesso falso, gravação atômica, estado vazio, recuperação de revisões e salvamentos concorrentes.
3. Unificar geração, seleção de modelos e referências; isolar narração por projeto.
4. Corrigir exportação, timecodes, cache, streaming e execução de produção.
5. Adicionar regressões dos defeitos confirmados, reduzir acoplamento e atualizar documentação.
