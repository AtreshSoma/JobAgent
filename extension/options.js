const $ = (id) => document.getElementById(id);
chrome.storage.local.get({ serverUrl: 'http://127.0.0.1:4646', key: '' }, (v) => {
  $('serverUrl').value = v.serverUrl;
  $('key').value = v.key;
});
$('save').addEventListener('click', async () => {
  const serverUrl = $('serverUrl').value.trim().replace(/\/$/, '');
  const key = $('key').value.trim();
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(serverUrl)) return show('Only a loopback HTTP server is allowed.', false);
  if (key.length < 32) return show('The extension key must contain at least 32 characters.', false);
  await chrome.storage.local.set({ serverUrl, key });
  show('Saved. Open an application tab and click the extension.', true);
});
function show(text, ok) { $('status').textContent = text; $('status').className = ok ? 'ok' : 'error'; }
