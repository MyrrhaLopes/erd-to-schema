/** Salva um Blob: File System Access API quando disponível (Chromium), senão `<a download>` */
export async function saveBlob(blob: Blob, filename: string, description = 'Arquivo') {
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
  };
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  if (w.showSaveFilePicker && window.self === window.top) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: ext ? [{ description, accept: { [blob.type || 'application/octet-stream']: [ext] } }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return false;
      // cai no fallback abaixo (ex.: tipo MIME não aceito)
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
