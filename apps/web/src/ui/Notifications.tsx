import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import type { Notification } from '@erd/contracts';
import { api, ok } from '../api/client';
import { sharingKeys, useMe, useNotifications } from '../api/queries';
import { relTime } from '../routes/Dashboard';
import { ROLE_LABEL } from './sharing';

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Texto e destino de cada tipo de notificação */
function describe(n: Notification): { text: string; to: string } {
  const p = n.payload as P;
  const project = str(p.projectName);
  const pid = str(p.projectId);
  switch (n.type) {
    case 'access-request':
      return { text: `${str(p.requester)} pediu acesso de edição a ${project}`, to: `/p/${pid}/settings?request=${str(p.requestId)}` };
    case 'access-decision':
      return { text: p.approved ? `Seu pedido de edição em ${project} foi aprovado` : `Seu pedido de edição em ${project} foi negado`, to: `/p/${pid}` };
    case 'member-added':
      return { text: `${str(p.by)} compartilhou ${project} com você (${ROLE_LABEL[p.role as 'editor'] ?? 'membro'})`, to: `/p/${pid}` };
    case 'role-changed':
      return { text: `${str(p.by)} mudou seu papel em ${project} para ${(ROLE_LABEL[p.role as 'editor'] ?? '').toLowerCase()}`, to: `/p/${pid}` };
    case 'member-removed':
      return { text: `${str(p.by)} removeu você de ${project}`, to: '/' };
    case 'project-transferred':
      return {
        text: `${str(p.by)} transferiu ${project} para você${p.driveNote ? ': conecte o seu Google Drive para trazer o documento' : ''}`,
        to: p.driveNote ? `/p/${pid}/settings` : `/p/${pid}`,
      };
    case 'drive-alert':
      return { text: `${project}: ${str(p.title)}. ${str(p.message)}`, to: `/p/${pid}/settings` };
    default:
      return { text: n.type, to: '/' };
  }
}

/** Sininho de notificações in-app, com o número de não lidas */
export function NotificationsBell() {
  const me = useMe();
  const q = useNotifications(!!me.data?.user);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  if (!me.data?.user) return null;
  const unread = q.data?.unread ?? 0;
  const markRead = async (ids?: string[]) => {
    await ok(api.notifications.read.$post({ json: { ids } })).catch(() => {});
    void qc.invalidateQueries({ queryKey: sharingKeys.notifications });
  };

  return (
    <div className="relative" ref={ref}>
      <button title="Notificações" data-testid="notifications" onClick={() => setOpen(!open)} className="relative rounded p-1.5 text-slate-500 hover:bg-slate-100">
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[9.5px] font-semibold leading-4 text-white" data-testid="unread">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-[12.5px] font-semibold text-slate-700">Notificações</span>
            {unread > 0 && (
              <button className="text-[11.5px] text-indigo-600 hover:underline" onClick={() => void markRead()}>
                Marcar todas como lidas
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {!q.data?.items.length && <li className="px-3 py-6 text-center text-[12.5px] text-slate-500">Nada por aqui.</li>}
            {q.data?.items.map((n) => {
              const d = describe(n);
              return (
                <li key={n.id}>
                  <button
                    data-testid="notification"
                    className={'flex w-full items-start gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-slate-50 ' + (n.readAt ? 'text-slate-500' : 'text-slate-800')}
                    onClick={() => {
                      setOpen(false);
                      if (!n.readAt) void markRead([n.id]);
                      void nav({ to: d.to });
                    }}
                  >
                    <span className={'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ' + (n.readAt ? 'bg-transparent' : 'bg-indigo-500')} />
                    <span className="flex-1">
                      {d.text}
                      <span className="block text-[11px] text-slate-400">{relTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
