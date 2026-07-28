# Documentação Completa e Guia de Transferência (Handover) - Storyboard & Screenplay Studio

> **Documento de Handover Técnico para Desenvolvimento no Antigravity / GitHub**  
> *Data:* Julho de 2026  
> *Aplicação:* Storyboard & Screenplay Studio (Nano Banana Engine)  
> *Stack:* React 19, TypeScript, Vite 6, Express 4, Tailwind CSS 4, Google Gemini API (@google/genai)

---

## 1. Visão Geral do Projeto

O **Storyboard & Screenplay Studio** é uma estação de trabalho completa desenvolvida para roteiristas, diretores de cinema e produtores audiovisuais. O aplicativo permite a criação, edição, organização e renderização de storyboards cinematográficos no formato **16:9 (Widescreen)**, acompanhados de roteiros técnicos detalhados (planos, ângulos de câmera, iluminação, diálogos, áudio e notas de produção).

### Principais Destaques do Sistema
- **Engine de Renderização Visual Nano Banana**: Suporte a geração de imagens por Inteligência Artificial (usando **Google Gemini / Imagen 3** com fallbacks automáticos em alta velocidade para **Pollinations AI Flux** e **Picsum Photos**).
- **Zero Black Frames & Zero Distorção**: Pipeline de conversão server-side para `data:image/...;base64` que elimina problemas de CORS, imagens pretas e falhas de carregamento em navegadores.
- **Manutenção de Proporção Cenográfica (16:9)**: Matemática de corte centralizado (`center-crop cover`) no HTML5 Canvas (`src/lib/imageUtils.ts`) garantindo que downloads em PNG e PDFs nunca fiquem esticados ou achatados.
- **Persistência Dupla Robusta**:
  1. **Servidor Local (Disco)**: Salva dados e imagens fisicamente na pasta `/projects/<pasta_do_projeto>/`.
  2. **Navegador (IndexedDB & LocalStorage)**: Cache local de alta performance com identificadores `idb://` para carregamento instantâneo.
- **Histórico de Versões por Cena**: Cada cena permite gerar múltiplas variações de imagens, alternando entre elas com um clique na barra de miniaturas.

---

## 2. Arquitetura e Estrutura de Arquivos

```
/
├── server.ts                   # Servidor backend Express (API de IA, persistência em disco, proxy de imagens)
├── src/
│   ├── main.tsx                # Ponto de entrada do React
│   ├── App.tsx                 # Gerenciador de estado global, persistência, atalhos de teclado e import/export
│   ├── index.css               # Estilos globais e Tailwind v4 (@import "tailwindcss")
│   ├── types.ts                # Definições de interfaces TypeScript (Scene, Storyboard, ImageVersion, etc.)
│   ├── components/
│   │   ├── StoryboardCard.tsx  # Card individual de cena (Viewport 16:9, controles de renderização, versões)
│   │   ├── Header.tsx          # Barra superior, menus de projetos, busca e ações globais
│   │   ├── TimelineView.tsx    # Visualização em linha do tempo cinematográfica
│   │   ├── ScriptEditor.tsx    # Editor de roteiro formatado com parser de cenas
│   │   └── ...                 # Outros componentes modulares
│   └── lib/
│       ├── imageUtils.ts       # Utilitários de Canvas 2D, exportação ZIP/PNG com matemática de proporção
│       └── indexedDB.ts        # Driver do IndexedDB para armazenamento local de alta capacidade
├── projects/                   # Diretório de armazenamento físico dos projetos (criado automaticamente)
│   └── <nome_do_projeto>/
│       ├── storyboard.json     # Estado JSON da história e cenas
│       └── imagens/            # Imagens salvas localmente no formato PNG/JPG
├── session_store.json          # Registro server-side de projetos e sessões ativas
├── package.json                # Dependências e scripts de execução
├── tsconfig.json               # Configuração TypeScript
└── vite.config.ts              # Configuração do Vite
```

---

## 3. Como Executar o Projeto Totalmente Local no PC

### Pré-requisitos
- **Node.js**: Versão 18, 20 ou superior instalada no sistema.
- **NPM** ou **Bun**: Gerenciador de pacotes.
- **Chave de API do Gemini (Opcional, mas recomendado)**: [Google AI Studio](https://aistudio.google.com/).

### Passo a Passo de Instalação e Execução

1. **Clonar o Repositório do GitHub**:
   ```bash
   git clone <URL_DO_SEU_REPOSITORIO_GITHUB>
   cd <NOME_DA_PASTA>
   ```

2. **Instalar as Dependências**:
   ```bash
   npm install
   ```

3. **Configurar as Variáveis de Ambiente**:
   Crie um arquivo `.env` na raiz do projeto (baseado no `.env.example`):
   ```env
   GEMINI_API_KEY="Sua_Chave_Gemini_Aqui"
   PORT=3000
   ```

4. **Executar em Modo de Desenvolvimento (Hot Reload)**:
   ```bash
   npm run dev
   ```
   Acesse a aplicação no navegador em: `http://localhost:3000`

5. **Gerar Build de Produção e Executar Localmente**:
   ```bash
   npm run build
   npm start
   ```

---

## 4. Funcionamento Interno dos Módulos Principais

### A. Pipeline de Geração e Renderização de Imagens (`server.ts` & `App.tsx`)
1. **Endpoint**: `POST /api/storyboard/generate-image`
2. **Motor de IA**:
   - Tenta invocar a SDK oficial `@google/genai` (Modelo `imagen-3.0-generate-002` / `gemini-2.5-flash`).
   - Se a cota do Gemini estiver excedida ou sem chave, aciona instantaneamente o motor **Pollinations AI Flux**.
   - Se o Pollinations estiver inacessível, aciona a API fotográfica **Picsum Photos**.
3. **Conversão Server-Side em Base64**:
   - Qualquer imagem remota baixada pelo servidor é convertida para `data:image/jpeg;base64,...` antes de ser enviada ao cliente.
   - **Benefício**: Evita bloqueios de CORS no navegador, garante carregamento offline e elimina quadros pretos (*black frames*).

### B. Salvamento em Disco Local (`server.ts`)
- **Endpoint**: `POST /api/storyboard/projects/save-image`
- As imagens geradas são gravadas fisicamente na pasta `./projects/<nome_do_projeto>/imagens/`.
- O caminho relativo no disco é registrado no arquivo `./projects/<nome_do_projeto>/storyboard.json`.

### C. Sistema de Download sem Distorção (`src/lib/imageUtils.ts`)
- A função `renderSvgToPngBlob` processa a renderização de imagens e exportação do storyboard.
- **Matemática Center-Crop**:
  ```typescript
  const imgRatio = naturalW / naturalH;
  const canvasRatio = canvasW / canvasH;

  if (imgRatio > canvasRatio) {
    drawW = canvasH * imgRatio;
    offsetX = (canvasW - drawW) / 2;
  } else {
    drawH = canvasW / imgRatio;
    offsetY = (canvasH - drawH) / 2;
  }
  ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
  ```
- Garante que a imagem preencha exatamente a proporção 16:9 sem achatar rostos, esticar personagens ou deixar bordas transparentes.

---

## 5. Rotas de API Backend (`server.ts`)

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Verificação de status do servidor local |
| `POST` | `/api/storyboard/generate-image` | Geração de imagem via IA/Fallback com conversão Base64 |
| `POST` | `/api/storyboard/projects/save-image` | Grava um buffer base64/URL na pasta `/projects/<folder>/imagens/` |
| `POST` | `/api/storyboard/projects/save-state` | Salva o estado do projeto no arquivo `storyboard.json` |
| `GET` | `/api/storyboard/projects/load-state` | Carrega o estado salvo de um projeto em disco |
| `GET` | `/api/storyboard/projects/list` | Lista todos os projetos salvos no diretório local `/projects` |

---

## 6. Próximos Passos Sugeridos para o Antigravity

Quando for continuar o desenvolvimento no **Antigravity**, recomenda-se explorar as seguintes melhorias:
1. **Integração de Áudio Local (VFX / Locução)**: Adicionar suporte a geração/upload de áudio por cena com player sincronizado na Timeline.
2. **Exportação em Vídeo MP4 / WebM**: Renderizar a sequência de quadros 16:9 em um arquivo de vídeo usando `ffmpeg.wasm` ou backend Node.js.
3. **Suporte a Múltiplos Formatos Aspect Ratio**: Permitir alternar entre 16:9 (Cinema), 9:16 (Vertical/Reels) e 1:1 (Quadrado) nas configurações da cena.
4. **Modo Apresentação / Pitching Deck**: Tela cheia interativa para apresentar o storyboard a clientes com transições de câmera.

---
*Fim do documento de handover.*
