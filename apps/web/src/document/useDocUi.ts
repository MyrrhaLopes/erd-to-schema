import { create } from 'zustand';
import type { Id } from '@erd/model/types';

/** Estado das telas do documento Word (formulário, revisão, publicação em andamento) */
interface DocUi {
  /** Diálogo "Documento Word" aberto, e em qual aba */
  open: 'form' | 'drive' | null;
  /** Tabela para rolar até ela no formulário ("Preencher no documento") */
  focusTable: Id | null;
  /** Só o que falta */
  onlyMissing: boolean;
  /** Tela "Revisar e publicar"; `revertFrom` = revertendo da publicação vN */
  review: { revertFrom?: number } | null;
  /** Publicação pedida por esta pessoa que ainda está na fila */
  publishing: { jobId: string; version: number } | null;
  set: (p: Partial<DocUi>) => void;
}

export const useDocUi = create<DocUi>((set) => ({
  open: null,
  focusTable: null,
  onlyMissing: false,
  review: null,
  publishing: null,
  set: (p) => set(p),
}));

export const openDocForm = (focusTable: Id | null = null) => useDocUi.getState().set({ open: 'form', focusTable, review: null });

/** Aviso do gateway único (§8.1) */
export const GATEWAY_WARNING =
  'Este documento é gerado pelo app. Para reverter, use o histórico de publicações daqui. Não edite nem restaure versões pelo Google Drive: isso cria conflitos com o que o app publica, e a próxima publicação sobrescreve.';
export const OWNER_WARNING = 'Você é o dono do arquivo no Drive e consegue desbloqueá-lo por lá. Não faça isso: o app vai detectar, avisar e sobrescrever.';
