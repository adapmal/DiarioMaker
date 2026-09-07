# Acompanhamento da auditoria — 05/09/2026

Este documento registra as decisões posteriores à auditoria original. As referências de linha da auditoria representam a versão examinada naquele momento.

## Implementado nesta etapa

- [x] Seleção da imagem ativa pelas miniaturas, histórico do chat e acervo não adiciona nível de Undo nem limpa Redo. Prompt e descrição associados continuam acompanhando a imagem e a seleção continua sendo salva. Edição manual e aplicação de uma imagem nova mantêm o histórico. Um Undo de uma edição anterior ainda restaura o snapshot completo dessa edição; não foi implementado histórico independente por campo.
- [x] A geração mantém IDs explícitos de modelos Google/OpenAI. IDs Gemini de imagem usam generateContent; IDs Imagen usam generateImages.
- [x] Referência raster é encaminhada ao Gemini ou ao endpoint de edição GPT Image. Imagen/DALL-E com referência recebem erro claro neste fluxo, sem trocar o modelo automaticamente.
- [x] OpenAI no estúdio envia o cabeçalho da chave. O servidor também recupera a chave já configurada quando o cabeçalho estiver ausente. A chave existente foi mantida, conforme escolha do usuário; nenhum segredo foi alterado.
- [x] Falhas de geração retornam erro e não são convertidas em imagens de erro adicionadas ao projeto. URLs externas de saída OpenAI precisam ser materializadas em Base64 antes do sucesso.
- [x] Novos salvamentos de bytes idênticos reutilizam um arquivo dentro do mesmo projeto, inclusive quando já existe um arquivo com nome legado. Requisições simultâneas compartilham a operação em andamento. Imagens diferentes continuam separadas.
- [x] O nome físico de novas imagens deriva de SHA-256; sceneId não participa do caminho. A rota save-image rejeita pasta com separadores, ponto/ponto-ponto ou NUL. As demais rotas ainda precisam da revisão de confinamento.

Os atalhos antigos foram explicitados: nano_banana → gemini-2.5-flash-image; nano_banana_pro → gemini-3-pro-image; nano_banana_2 → gemini-3.1-flash-image. Um ID explícito selecionado pelo usuário não é substituído por esses atalhos. Disponibilidade e acesso à conta continuam sujeitos ao provedor.

## Duplicação observada

Inspeção somente de leitura em projects/*/imagens: 560 arquivos, aproximadamente 1.230 MB. Comparando SHA-256 dentro de cada projeto, foram encontrados 74 grupos duplicados, com 157 arquivos adicionais idênticos e aproximadamente 273 MB adicionais.

A causa identificada: cada requisição antiga de save-image criava nome com timestamp/aleatório, e a hidratação podia enviar os mesmos bytes separadamente como imagem ativa, versão e item do acervo. A nova escrita evita acrescentar cópias idênticas por esse caminho.

Nenhum arquivo existente foi apagado, renomeado ou reescrito. Não foi feita migração dos JSONs antigos nem deduplicação de todas as representações do acervo. Imagens visualmente iguais com bytes diferentes não são consideradas duplicatas por essa correção.

## Implementado nesta etapa (Pacote de Correções Imediatas - 05/09/2026)

- [x] **Limpar temporários isolado:** A rota `/api/storyboard/projects/clear-cache` foi corrigida para purgar exclusivamente arquivos dentro de `projects/<pasta>/cache/`. Ela nunca toca na pasta `imagens/`, nem no `storyboard.json`, nem em backups ou na sessão ativa.
- [x] **Escuta local (127.0.0.1):** Servidor HTTP configurado para fazer bind seguro em `127.0.0.1` (loopback), impedindo exposição acidental da aplicação em rede local sem autorização.
- [x] **Confinamento e segurança em áudio local:** A rota `/api/storyboard/stream-local-audio` passou por restrição estrita de extensões permitidas (`.mp3`, `.wav`, `.m4a`, `.aac`, `.ogg`, `.flac`, `.wma`), bloqueio de arquivos sensíveis/ocultos do sistema, suporte padrão a RFC 7233 (Range/416) e escuta de eventos de erro nos streams de leitura.
- [x] **Gravação atômica e tratamento real de falhas:** Implementada função auxiliar `atomicWriteFileSync` (gravação em arquivo temporário com rename atômico). O servidor não retorna mais falso sucesso `{ success: true }` quando o disco falha: retorna HTTP 500 e propaga a exceção.
- [x] **Persistência de projeto vazio / remoção da última cena:** O frontend e o backend agora reconhecem arrays vazios (`scenes: []`) como estados válidos de projeto, permitindo que a remoção de todas as cenas seja salva tanto no `localStorage` quanto no `storyboard.json` sem ser ignorada ou ressuscitar cenas em recargas.
- [x] **Validação estrita de pastas de projeto:** `validateProjectFolder` protege contra tentativas de Directory Traversal (`..`, separadores de caminho, bytes nulos).

## Marcado para próxima etapa

- [ ] **Recuperação:** comparar revisões por projeto, preservar alterações locais ainda não confirmadas e evitar sobrescrita concorrente.
- [ ] **Duplicatas antigas:** preparar migração que primeiro atualize todas as referências, mantenha recuperação e só depois remova arquivos redundantes. Não apagar apenas por igualdade de hash sem considerar referências e backups.

## Validação

- npm test: 15 testes passaram (incluindo testes dedicados de confinamento de pastas, gravação atômica, preservação de imagens na limpeza de cache e segurança de streaming de áudio).
- npm run lint: passou.
- tsc --noEmit: zero erros de tipo TypeScript.
- As APIs foram substituídas por respostas simuladas nos testes. Não foram consumidas chamadas pagas nem verificada a validade da chave ou autorização de modelos na conta.
- Não houve teste visual completo do aplicativo nesta etapa.

## Referências de implementação

- [Geração de imagens OpenAI](https://developers.openai.com/api/docs/guides/image-generation): geração/edição, Base64 e tamanhos por modelo.
- [Geração de imagens Gemini](https://ai.google.dev/gemini-api/docs/generate-content/image-generation): conteúdo multimodal, imagem de referência e aspect ratio. O código utiliza imageConfig, disponível no SDK instalado.
