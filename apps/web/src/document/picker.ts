import type { DriveConfig } from '@erd/contracts';

/**
 * Google Picker para escolher a pasta (§2.1). Com `drive.file`, é o Picker que dá ao app
 * acesso à pasta escolhida — por isso o `setAppId` é obrigatório.
 */
interface PickerNs {
  ViewId: { FOLDERS: string };
  Action: { PICKED: string; CANCEL: string };
  DocsView: new (viewId: string) => {
    setSelectFolderEnabled(v: boolean): unknown;
    setIncludeFolders(v: boolean): unknown;
    setMimeTypes(m: string): unknown;
    setParent(id: string): unknown;
    setEnableDrives?(v: boolean): unknown;
    setLabel?(l: string): unknown;
  };
  PickerBuilder: new () => PickerBuilder;
  Feature: { SUPPORT_DRIVES: string };
}
interface PickerBuilder {
  addView(v: unknown): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  enableFeature(f: string): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  setLocale(l: string): PickerBuilder;
  setCallback(cb: (data: { action: string; docs?: { id: string; name: string }[] }) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}

declare global {
  interface Window {
    gapi?: { load(name: string, cb: () => void): void };
    google?: { picker: PickerNs };
  }
}

let loading: Promise<PickerNs> | null = null;
function loadPicker(): Promise<PickerNs> {
  return (loading ??= new Promise((resolve, reject) => {
    const ready = () => window.gapi!.load('picker', () => resolve(window.google!.picker));
    if (window.gapi) return ready();
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.async = true;
    s.onload = ready;
    s.onerror = () => {
      loading = null;
      reject(new Error('Não foi possível carregar o seletor do Google'));
    };
    document.head.appendChild(s);
  }));
}

export async function pickGoogleFolder(cfg: DriveConfig, token: string): Promise<{ id: string; name: string } | null> {
  const picker = await loadPicker();
  return new Promise((resolve) => {
    const folders = (label: string) => {
      const v = new picker.DocsView(picker.ViewId.FOLDERS);
      v.setSelectFolderEnabled(true);
      v.setIncludeFolders(true);
      v.setMimeTypes('application/vnd.google-apps.folder');
      v.setLabel?.(label);
      return v;
    };
    // duas abas: `setEnableDrives` transforma a view na de drives compartilhados, então numa
    // view só o Meu Drive sumia do seletor
    const mine = folders('Meu Drive');
    mine.setParent('root');
    const shared = folders('Drives compartilhados');
    shared.setEnableDrives?.(true);
    new picker.PickerBuilder()
      .addView(mine)
      .addView(shared)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setTitle('Escolha a pasta do documento')
      .setLocale('pt-BR')
      .setOAuthToken(token)
      .setDeveloperKey(cfg.pickerApiKey ?? '')
      .setAppId(cfg.appId ?? '')
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED && data.docs?.[0]) resolve({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
