import { useSyncExternalStore } from 'react';
import { getSession, onSessionChange, type Session } from './session';

/** A sessão (canvas) aberta no momento, como estado do React */
export function useSession(): Session | null {
  return useSyncExternalStore(onSessionChange, getSession, getSession);
}
