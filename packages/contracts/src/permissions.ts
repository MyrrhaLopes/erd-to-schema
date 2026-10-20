import { z } from 'zod';

export const ROLES = ['owner', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const RoleZ = z.enum(ROLES);

/** Papéis que se pode atribuir a alguém (a posse só muda por transferência) */
export const AssignableRoleZ = z.enum(['editor', 'viewer']);
export type AssignableRole = z.infer<typeof AssignableRoleZ>;

export const ProjectSettingsZ = z.object({
  /** Editores podem convidar, mudar papéis e aprovar pedidos de acesso */
  editorsCanShare: z.boolean().default(false),
  /** Link de visualização: qualquer usuário logado com o link entra como viewer */
  linkSharing: z.enum(['off', 'view']).default('off'),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsZ>;
export const defaultSettings = (): ProjectSettings => ({ editorsCanShare: false, linkSharing: 'off' });

export type Action =
  | 'view'
  | 'export'
  | 'edit'
  | 'share'
  | 'manageMembers'
  | 'approveRequests'
  | 'rename'
  | 'delete'
  | 'transfer'
  | 'requestAccess'
  | 'manageCanvases'
  | 'changeSettings'
  | 'driveConfigure'
  | 'drivePublish';

/**
 * A regra de autorização num lugar só (§3), usada pela API, pelo servidor de colaboração
 * e pela interface. A interface só esconde botões; quem garante são a API e o collab.
 *
 * | Ação                                         | owner | editor               | viewer |
 * |----------------------------------------------|:-----:|:--------------------:|:------:|
 * | ver, exportar, presença                      |   ✔   |  ✔                   |   ✔    |
 * | editar canvas/painéis/notas                  |   ✔   |  ✔                   |   ✘    |
 * | convidar, mudar papéis, remover, aprovar     |   ✔   |  se `editorsCanShare` |   ✘    |
 * | renomear projeto, criar canvases             |   ✔   |  ✔                   |   ✘    |
 * | excluir, transferir, configurações           |   ✔   |  ✘                   |   ✘    |
 * | pedir acesso de edição                       |   —   |  —                   |   ✔    |
 * | Drive: conectar, escolher/trocar pasta       |   ✔   |  ✘                   |   ✘    |
 * | Drive: revisar e publicar, reverter          |   ✔   |  ✔                   |   ✘    |
 */
export function can(role: Role | null | undefined, action: Action, settings?: Partial<ProjectSettings>): boolean {
  if (!role) return false;
  switch (action) {
    case 'view':
    case 'export':
      return true;
    case 'edit':
    case 'rename':
    case 'manageCanvases':
    case 'drivePublish':
      return role === 'owner' || role === 'editor';
    case 'share':
    case 'manageMembers':
    case 'approveRequests':
      return role === 'owner' || (role === 'editor' && !!settings?.editorsCanShare);
    case 'delete':
    case 'transfer':
    case 'changeSettings':
    case 'driveConfigure':
      return role === 'owner';
    case 'requestAccess':
      return role === 'viewer';
  }
}

/** Paleta de 12 cores acessíveis (contraste testado nos temas claro e escuro), uma por membro */
export const MEMBER_COLORS = [
  '#e11d48',
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4f46e5',
  '#65a30d',
  '#ea580c',
  '#0d9488',
  '#9333ea',
] as const;

export const colorOf = (index: number | null | undefined) => MEMBER_COLORS[((index ?? 0) % MEMBER_COLORS.length + MEMBER_COLORS.length) % MEMBER_COLORS.length];

/** Menor índice de cor ainda não usado no projeto (a cor é estável por membro) */
export function pickColor(used: number[]): number {
  const taken = new Set(used.map((u) => u % MEMBER_COLORS.length));
  for (let i = 0; i < MEMBER_COLORS.length; i++) if (!taken.has(i)) return i;
  return used.length % MEMBER_COLORS.length;
}
