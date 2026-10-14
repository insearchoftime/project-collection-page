(() => {
  'use strict';
  const gate = document.getElementById('gate');
  const status = document.getElementById('status');
  const retry = document.getElementById('retry');
  let frame = document.getElementById('content');
  const decoder = new TextDecoder();
  const aad = new TextEncoder().encode('project-collection/v1');
  let files = null;
  let unlockedKey = null;
  let loading = false;

  function decode64(text) {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  function fail(message) {
    frame.hidden = true;
    gate.hidden = false;
    status.textContent = message;
    status.classList.add('error');
    retry.hidden = false;
  }

  function parameters() {
    return new URLSearchParams(location.hash.slice(1));
  }

  function currentRoute() {
    const p = parameters();
    return { path: p.get('page') || 'index.html', anchor: p.get('anchor') || '' };
  }

  function routeFragment(path, anchor) {
    const p = new URLSearchParams({ key: unlockedKey });
    if (path !== 'index.html') p.set('page', path);
    if (anchor) p.set('anchor', anchor);
    return '#' + p.toString();
  }

  function routeBridge(path, anchor) {
    const jsString = value => JSON.stringify(value).replace(/</g, '\\u003c');
    return `(() => {
      const currentPath = ${jsString(path)};
      document.addEventListener('click', event => {
        const a = event.target.closest('a[href]');
        if (!a) return;
        const raw = a.getAttribute('href');
        if (!raw) return;
        if (raw.startsWith('#')) {
          event.preventDefault();
          const anchor = decodeURIComponent(raw.slice(1));
          document.getElementById(anchor)?.scrollIntoView();
          parent.postMessage({kind:'collection:anchor',path:currentPath,anchor}, '*');
          return;
        }
        if (/^https?:/i.test(raw)) {
          a.target = '_top'; a.rel = 'noreferrer noopener'; return;
        }
        const u = new URL(raw, 'https://collection.invalid/' + currentPath);
        if (u.origin !== 'https://collection.invalid') return;
        let target = decodeURIComponent(u.pathname).replace(/^\\//, '');
        if (!target || target.endsWith('/')) target += 'index.html';
        event.preventDefault();
        parent.postMessage({kind:'collection:route',path:target,anchor:decodeURIComponent(u.hash.slice(1))}, '*');
      });
      const anchor = ${jsString(anchor)};
      if (anchor) {
        const jump = () => document.getElementById(anchor)?.scrollIntoView();
        if (document.readyState === 'complete') jump();
        else window.addEventListener('load', jump, {once:true});
      }
    })();`;
  }

  function render(path, anchor = '') {
    const file = files.get(path);
    if (!file) { fail('Этот раздел не найден. Откройте исходную секретную ссылку.'); return; }
    if (!file.mime.startsWith('text/html')) { download(path); return; }
    let html = decoder.decode(decode64(file.body));
    const referrer = '<meta name="referrer" content="no-referrer">';
    html = html.replace('</head>', referrer + '</head>');
    const bridge = '<script>' + routeBridge(path, anchor) + '<' + '/script>';
    html = html.replace('</body>', bridge + '</body>');
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || 'Коллекция проектов';
    document.title = title;
    // Recreate the browsing context even when restoring identical HTML from the back/forward cache.
    const replacement = frame.cloneNode(false);
    replacement.removeAttribute('src');
    replacement.title = title;
    replacement.srcdoc = html;
    frame.replaceWith(replacement);
    frame = replacement;
    frame.hidden = false;
    gate.hidden = true;
  }

  function download(path) {
    const file = files.get(path);
    if (!file) return;
    const url = URL.createObjectURL(new Blob([decode64(file.body)], { type: file.mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split('/').pop();
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || !files || !['collection:route', 'collection:anchor'].includes(event.data?.kind)) return;
    const { path, anchor = '' } = event.data;
    if (typeof path !== 'string' || typeof anchor !== 'string' || !files.has(path)) return;
    if (event.data.kind === 'collection:anchor') { history.replaceState(null, '', routeFragment(path, anchor)); return; }
    if (!files.get(path).mime.startsWith('text/html')) { download(path); return; }
    history.pushState(null, '', routeFragment(path, anchor));
    render(path, anchor);
  });

  async function unlock() {
    if (loading) return;
    const keyText = parameters().get('key');
    if (!keyText) {
      frame.hidden = true; gate.hidden = false; retry.hidden = true;
      status.classList.remove('error');
      status.textContent = 'Откройте полную секретную ссылку, чтобы увидеть коллекцию.';
      return;
    }
    if (files && unlockedKey === keyText) {
      const r = currentRoute(); render(r.path, r.anchor); return;
    }
    loading = true;
    files = null; unlockedKey = null;
    gate.hidden = false; frame.hidden = true; retry.hidden = true;
    status.classList.remove('error');
    status.textContent = 'Открываем коллекцию…';
    try {
      if (!crypto.subtle || typeof DecompressionStream === 'undefined') throw new Error('unsupported');
      if (!/^[A-Za-z0-9_-]{43}$/.test(keyText)) throw new Error('key');
      const rawKey = decode64(keyText);
      const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
      const response = await fetch('vault.bin', { credentials: 'omit', cache: 'no-cache', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('network');
      const vault = new Uint8Array(await response.arrayBuffer());
      if (decoder.decode(vault.slice(0, 8)) !== 'PCVAULT1') throw new Error('format');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.slice(8, 20), additionalData: aad, tagLength: 128 }, key, vault.slice(20));
      const unpacked = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
      const bundle = JSON.parse(await new Response(unpacked).text());
      if (bundle.version !== 1 || !Array.isArray(bundle.files)) throw new Error('format');
      files = new Map(bundle.files.map(file => [file.path, file]));
      if (!files.has('index.html')) throw new Error('format');
      unlockedKey = keyText;
      const r = currentRoute(); render(r.path, r.anchor);
    } catch (error) {
      files = null; unlockedKey = null;
      const message = error.message === 'unsupported'
        ? 'Для этой ссылки нужен современный браузер с поддержкой Web Crypto.'
        : error.message === 'network'
        ? 'Не удалось загрузить коллекцию. Проверьте соединение и попробуйте ещё раз.'
        : 'Ссылка неполная или ключ не подходит. Откройте полную секретную ссылку.';
      fail(message);
    } finally { loading = false; }
  }

  retry.addEventListener('click', unlock);
  // WebKit may restore the parent from the back/forward cache with an empty srcdoc frame.
  window.addEventListener('pageshow', unlock);
  window.addEventListener('hashchange', unlock);
  window.addEventListener('popstate', unlock);
  unlock();
})();
