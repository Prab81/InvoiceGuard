// Handing a generated file to the reviewer.
//
// Some hosts sandbox the page and silently drop downloads it starts itself.
// There is no reliable way to ask whether that is the case, so the download is
// always attempted and the caller is told when the page is running somewhere
// that may swallow it, rather than the file appearing to vanish.

export const inSandboxedFrame = (() => {
  try { return globalThis.self !== globalThis.top; } catch { return true; }
})();

export function saveFile(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { started: true, sandboxed: inSandboxedFrame };
  } finally {
    // Give the browser a moment to pick the blob up before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

export const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  json: 'application/json',
};

/** Read a file the reviewer picked, as text. */
export function readTextFile(accept = 'application/json') {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file chosen.')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result) });
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsText(file);
    });
    input.click();
  });
}
