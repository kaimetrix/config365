'use client';

/** POST JSON with upload progress (fetch has no upload progress events). */
export function postJsonWithProgress<T>(
  url: string,
  body: T,
  opts?: { onProgress?: (percent: number) => void; signal?: AbortSignal },
): Promise<Response> {
  const json = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'text';

    xhr.upload.onprogress = (event) => {
      if (!opts?.onProgress) return;
      if (event.lengthComputable) {
        opts.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      } else {
        opts.onProgress(0);
      }
    };

    xhr.onload = () => {
      const ct = xhr.getResponseHeader('Content-Type') ?? '';
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: ct ? { 'Content-Type': ct } : undefined,
        }),
      );
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));

    if (opts?.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        return;
      }
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(json);
  });
}

export async function readJsonApiResponse<T extends { error?: string }>(
  res: Response,
): Promise<T> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    const text = (await res.text()).trim();
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  const data = (await res.json()) as T;
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
