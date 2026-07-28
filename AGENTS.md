# AGENTS.md - Diretrizes para Agentes Antigravity / Coding Assistants

Este arquivo define os padrões técnicos, regras arquiteturais e salvaguardas essenciais para qualquer agente de IA que continue o desenvolvimento deste projeto.

## 1. Visão Geral do Projeto
O **Storyboard & Screenplay Studio** é uma aplicação full-stack (Express 4 + React 19 + Vite + TypeScript) para criação, edição e renderização de storyboards cinematográficos 16:9.

## 2. Regras Críticas de Desenvolvimento

### A. Preservação do Server-Side Base64 (Zero Black Frames)
- **NUNCA** retorne URLs de imagens HTTP/HTTPS externas puras diretamente para o cliente se puderem sofrer com bloqueios de CORS, hotlinking ou latência.
- Todas as rotas de imagem no `server.ts` de preferência devem converter buffers em `data:image/...;base64,...`. Isso garante renderização offline instantânea e impede o aparecimento de quadros pretos ou telas piscantes.

### B. Manutenção de Proporção sem Distorção (16:9)
- O renderizador no `src/lib/imageUtils.ts` usa matemática de corte centralizado (`center-crop cover`) no Canvas HTML5 (`canvas.width = 1920`, `canvas.height = 1080`).
- **NUNCA** utilize `ctx.drawImage(img, 0, 0, width, height)` diretamente com dimensões fixas sem antes calcular o `aspectRatio` do elemento original para evitar deformar a imagem.

### C. Persistência Dupla (Disco Local + IndexedDB)
- O estado dos projetos reside na pasta `./projects/<nome_do_projeto>/storyboard.json` e no servidor `session_store.json`.
- O cliente React usa cache de chave `idb://` para imagens pesadas em Base64 no IndexedDB para evitar extrapolar limites do LocalStorage.

### D. Estrutura dos Scripts em package.json
- O comando dev deve rodar via `tsx server.ts`.
- O build compila o backend com `esbuild` em `dist/server.cjs` e o frontend em `dist/`.
- O comando start executa `node dist/server.cjs`.

## 3. Documentação Completa
Consulte o arquivo `PROJECT_HANDOVER.md` para obter a explicação detalhada de cada módulo, rota de API e arquitetura do aplicativo.
