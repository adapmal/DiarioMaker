export interface SampleScript {
  title: string;
  category: "biblical" | "modern";
  theme: string;
  styleLabel: string;
  text: string;
}

export const SAMPLE_SCRIPTS: SampleScript[] = [
  {
    title: "O Horto das Oliveiras",
    category: "biblical",
    theme: "Jesus em profunda súplica",
    styleLabel: "Estilo Caravaggio (Claro-Escuro Dramático)",
    text: "Jesus orava no Horto das Oliveiras, sob o luar pálido daquela noite silenciosa. Uma gota de suor denso caía na terra poeirenta do solo. A sua profunda angústia humana era visível no franzir da testa e nas mãos apertadas em súplica fervorosa. Enquanto isso, seus três discípulos mais próximos dormiam cansados sob as copas das oliveiras centenárias, alheios à agonia interior que preludiava a crucificação."
  },
  {
    title: "São José de Anchieta na Praia",
    category: "biblical",
    theme: "Contemplação à beira-mar",
    styleLabel: "Estilo Caravaggio (Foco Barroco / Postura Épica)",
    text: "São José de Anchieta caminha sozinho à beira-mar na praia úmida. O vento repentino agita sua batina escura e surrada enquanto ele segura um cajado simples de madeira. Com os olhos focados no céu carregado de nuvens pesadas e douradas pelo entardecer, ele escreve versos na areia molhada. Ao fundo, as ondas revoltas se chocam contra pedras escuras."
  },
  {
    title: "Garoa na São João",
    category: "modern",
    theme: "Espera silenciosa sob o asfalto frio",
    styleLabel: "Realismo Urbano Brasileiro (Garoa e Neon)",
    text: "Um jovem trabalhador paulistano com casaco de moletom desgastado aguarda solitário no ponto de ônibus da Avenida São João. O brilho dos letreiros de neon reflete no asfalto molhado pela garoa fria das cinco da manhã. Ele junta os braços rente ao corpo para se proteger do vento gelado, enquanto os faróis amarelados de um ônibus começam a despontar na penumbra da avenida vazia."
  },
  {
    title: "Dona Maria na Cozinha",
    category: "modern",
    theme: "Trabalho virtuoso e simplicidade",
    styleLabel: "Realismo Urbano (Luz Natural Contemplativa)",
    text: "Dona Maria limpa com cuidado o balcão de inox de uma pequena lanchonete na periferia do Rio de Janeiro ao fim do expediente. A luz poente passa pela janela, revelando as linhas de expressão marcantes em seu rosto e um sorriso singelo de serenidade. No fogão ao fundo, uma chaleira de alumínio polido solta fumaça indicando café fresco, retratando a beleza silenciosa do cotidiano."
  }
];
