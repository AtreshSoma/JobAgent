chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'JOB_AGENT_FETCH_ARTIFACT') return false;
  (async () => {
    try {
      const response = await fetch(message.url, {
        headers: { 'x-job-agent-key': message.key },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      sendResponse({ ok: true, base64: btoa(binary), type: response.headers.get('content-type') || '', name: message.name });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true;
});
