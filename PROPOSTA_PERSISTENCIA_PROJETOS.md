# Revisão e proposta de persistência — 06/09/2026

Status: proposta para implementação, sem migração nem alteração do código funcional nesta revisão.

## Revalidação do código atual

| Item | Estado observado |
|---|---|
| Limpar temporários | A rota agora atua em cache/, preservando imagens e JSON. Falhas individuais de exclusão ainda são ignoradas; subpastas não são limpas. |
| Exposição de rede | Bind padrão em 127.0.0.1; HOST pode sobrescrever esse padrão. Configuração efetiva em execução não foi inspecionada. |
| Escrita do projeto | Usa temporário + rename e propaga erro na cópia principal. Falha da sessão global continua sendo apenas aviso. |
| Projeto vazio | Salvamento e restauração aceitam scenes: []. |
| Seleção sem Undo | Continua implementada; teste passou. |
| Geração/modelos/referência | Despacho e testes simulados continuam funcionando. Não houve chamadas pagas. |
| Deduplicação física | REGRESSÃO: server/imageStore.ts existe, mas server.ts não importa/chama storeProjectImage. save-image voltou a timestamp/aleatório e sceneId no caminho. |
| Confinamento | Validado em save/load/clear-cache, mas save-image voltou a usar apenas basename. Caminhos reais/junctions e outras rotas ainda precisam de revisão. |
| Áudio local | Filtro de extensão e tratamento de stream melhoraram; não equivalem a autorização por arquivo. A leitura continua aceitando caminhos externos com extensão permitida. |
| Recuperação de revisões | Ainda prefere servidor quando existe uma sessão, sem conciliar edições locais posteriores. |
| Concorrência | Efeito React ainda dispara gravações completas sem fila e duplica a escrita da sessão global. |
| Feedback de salvamento | Resposta HTTP de erro não recebe aviso visível no caminho principal. |
| Demais achados | MIME data:image/png, EDL acumulando durações e confirmação IndexedDB anterior ao commit ainda aparecem no código. Proxy arbitrário/configuração com chaves não foram resolvidos integralmente. |

Verificações: npm run lint passou; npm run build passou com aviso de bundle (765,26 kB). npm test: 17 testes, 16 passaram; teste de cache falhou por EPERM ao criar projects/audit_cache_safety_test/cache neste ambiente. Isso não comprova falha da rota de cache. Alguns testes de segurança reproduzem uma lógica local ou verificam texto de código; não exercitam as rotas reais. Os testes do imageStore passaram apesar de o serviço estar desconectado da rota — falta cobertura de integração.

## Comportamento atual da pasta

- src/App.tsx:4923 permite editar projectFolder diretamente e dispara salvamentos pela mudança de estado.
- handleBrowseFolder usa apenas folderName, descartando folderPath retornado pelo seletor.
- server.ts:546 salva sempre em cwd/projects/<folder>/storyboard.json.
- As imagens antigas mantêm referências às pastas anteriores; áudio ainda deriva de projectName em diversos fluxos.
- Portanto, alterar a pasta não é mover nem duplicar um projeto completo. Renomear o título também não cria um arquivo nomeado.

## Contrato proposto para a interface

1. Exibir nome do arquivo ativo e caminho completo da pasta, somente leitura para a pasta. Caminho longo pode ser abreviado visualmente, com tooltip e opção Copiar caminho.
2. Ícone de pasta executa Revelar no Explorer, usando o local confirmado pelo servidor. Não abre seletor nem altera estado. Projeto ainda não salvo abre o fluxo de primeiro salvamento.
3. Salvar (Ctrl+S) confirma gravação no arquivo ativo.
4. Salvar como permite outro nome na mesma pasta, reaproveitando mídias. Cria novo documento, conserva o anterior e ativa o novo somente após confirmação do disco.
5. Salvar cópia em outra pasta cria conjunto independente com todas as mídias necessárias; padrão de UX: continuar no original, com opção explícita Abrir cópia.
6. Mover projeto abre diálogo com origem, destino e conteúdo incluído. Cópia validada antes de remover qualquer origem.
7. Editar nome continua possível, mas confirmar nome por Enter/botão cria o novo arquivo (sem criar um arquivo a cada tecla). Cancelar não modifica arquivo. O arquivo anterior permanece disponível, conforme a intenção do usuário de salvar com outro nome.

## Estrutura de disco

```text
D:/Meus Projetos/Viagem/
  Viagem.dmproj
  Viagem - montagem 2.dmproj
  midias/
    imagens/<sha256>.png
    audio/<sha256>.wav
    referencias/<sha256>.jpg
  cache/
    <documentId>/miniaturas/
    <documentId>/ondas-audio/
    <documentId>/temporarios/
  backups/
    <documentId>/<nome>-<data>-r<revisao>.dmproj
  .diariomaker/
    storage.json
    operations/
```

.dmproj é inicialmente JSON versionado, sem obrigar ZIP ou banco de dados novo. O nome identifica o documento; documentId permanece estável durante o trabalho e não deriva do título. Outro Salvar como cria novo documentId e registra a origem. storageId identifica a pasta de mídias compartilhada pelos documentos daquela pasta.

Cache contém apenas dados regeneráveis. Imagens finais, versões, referências, narrações e fontes necessárias à reconstrução ficam em midias/. Backups não são cache. Separar caches por ID evita quebra quando o nome muda. A associação do cache ao nome aparece na interface e no manifesto, sem depender do nome para encontrar arquivos.

O projeto usa assetId por conteúdo e uma tabela de ativos com caminho relativo, MIME, tamanho e hash. Uma imagem ativa e várias versões podem referenciar o mesmo assetId. Exemplo: midias/imagens/abc.png, nunca D:/... nem /projects/nome-antigo/.... URLs HTTP são construídas em tempo de execução, não são a identidade persistida do ativo.

Devem integrar o documento: cenas, imagem ativa, todas as versões, chat por versão, referências, narração, tempos, acervo pertinente ao projeto e preferências de edição. Credenciais e catálogo global ficam fora dele. Não depender de localStorage para reabrir um documento completo.

## Mover e salvar cópia

Antes da operação, concluir ou pausar jobs que possam acrescentar ativos e esvaziar a fila de salvamento. Novas alterações não podem ser gravadas no destino antigo por callbacks atrasados.

Preflight: caminhos absolutos e reais de origem/destino; rejeitar origem=destino, destino dentro da origem, colisão silenciosa, nomes inválidos, destino indisponível. Enumerar documentos, mídias, backups e dependências. Medir espaço e apresentar o escopo real.

Copiar para staging no destino, registrar progresso em journal, validar bytes/hashes e integridade do documento, gravar manifesto e arquivo final, abrir/verificar a cópia e só então alterar o registro de localização ativo. Arquivos temporários devem estar no volume do destino para o commit local. Falha mantém original íntegro; reinício reconhece operação interrompida.

Se a pasta contiver vários .dmproj compartilhando mídias, não remover os arquivos usados pelos documentos que ficaram. Mover a pasta inteira é uma operação explícita que inclui esses documentos. Mover só o documento ativo deve coletar suas dependências em pasta própria; remover somente seu arquivo antigo após validação, preservando mídias compartilhadas e backups antigos.

Na movimentação integral, caminhos relativos continuam válidos e o registro de localização passa ao destino. Na migração, referências absolutas e URLs antigas precisam ser convertidas. Em Salvar cópia, o documento original permanece intacto. Não deixar um JSON antigo com referências quebradas apontando para mídias removidas.

O destino passa a ser uma pasta autorizada e registrada no backend; o frontend envia um identificador de projeto, não um caminho arbitrário a cada save. Servir ativos por /api/projects/<documentId>/assets/<assetId>, com confinamento pelo caminho real da raiz registrada. Explorer usa processo assíncrono com argumentos separados, sem montar comandos de shell com caminhos do usuário.

## Salvamento e recuperação

Arquivo ativo no disco é a fonte oficial; IndexedDB continua como cache e rascunho de recuperação por documentId. session_store deve evoluir para registro de sessão/recentes/localizações, não segunda cópia concorrente do projeto inteiro.

Uma fila por documento serializa gravações. Debounce de alterações, flush explícito em Ctrl+S, controle de geração da sessão para descartar callbacks antigos e bloqueio/transação durante mudança de destino. Resposta confirma documentId, revision, operação e instante de persistência. O cliente envia baseRevision; revisão divergente devolve conflito, não sobrescreve silenciosamente. Não usar apenas relógios/timestamps para decidir o vencedor.

Gravar mídias necessárias antes do JSON que as referencia; concluir escrita do temporário, sincronizar quando suportado e renomear. Somente depois marcar Salvo. Manter versão anterior para recuperação. UI: Alterações não salvas → Salvando → Salvo às ..., ou Falha ao salvar, mantendo estado sujo e opção Tentar novamente/Salvar cópia.

Autosave e backups de segurança pertencem ao documento e à sua pasta. Retenção sugerida: snapshots periódicos e antes de operações estruturais, com limite configurável; não apagar mídias referenciadas por documentos/backups ainda mantidos.

Ao abrir: validar schema e referências; distinguir documento vazio de ausente/corrompido; verificar rascunho local e operações pendentes. Conflito oferece recuperação da versão local sem destruir a do disco. Pasta movida manualmente pode ser localizada pelo usuário; abrir um .dmproj em outro local redefine a raiz e valida seus ativos relativos.

## Migração e ordem de implementação

1. Restaurar integração da deduplicação e adicionar teste da rota real. Extrair ProjectRepository, AssetStore e SaveCoordinator de server.ts/App.tsx.
2. Implementar formato versionado, IDs, registro de raiz e resolvedor de mídias. Leitor legado continua disponível. Escritor novo não deve continuar atualizando storyboard.json em paralelo.
3. Migrar por cópia: preservar originais, coletar imagens/versões/acervo/referências/áudio inclusive de outras pastas e IndexedDB. Faltantes são listados; não declarar pacote completo com arquivos ausentes. Validar reload do novo documento antes de ativá-lo.
4. Integrar fila, revisões, recuperação e estados visíveis. Remover gravações duplicadas da sessão global.
5. Trocar controles por pasta somente leitura, Revelar, Salvar como e Salvar cópia. Confirmar nome ao concluir edição.
6. Implementar Mover com staging, validação e retomada. Nenhuma limpeza destrutiva de projetos antigos na primeira migração.

## Critérios de aceitação

- Alterar nome cria exatamente um arquivo novo após confirmação; ambos abrem com imagens, versões, chat e áudio corretos.
- Selecionar imagem existente continua sem novo Undo e sem cópia física adicional.
- Salvar vazio e reabrir mantém vazio.
- Falta de espaço/permissão deixa última versão válida e erro visível.
- Respostas fora de ordem/duas abas não sobrescrevem revisão nova.
- Copiar ou mover entre unidades preserva todos os vínculos; interrupção no meio mantém original utilizável.
- Mover documento compartilhado preserva os demais e os backups.
- Limpar cache não altera mídia definitiva nem impede reabrir qualquer documento preservado.
- Abrir pasta externa funciona; Revelar abre essa pasta exata, sem alterar o destino.
- Testes de integração exercitam endpoints reais com serviços/filesystem isolados, não apenas uma cópia da lógica.
