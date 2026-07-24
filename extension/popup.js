const $ = (id) => document.getElementById(id);

initialize();

async function initialize() {
  const settings = await chrome.storage.local.get({
    serverUrl: 'http://127.0.0.1:4646', key: '', lastJobId: '', trustedHosts: {},
  });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const dashboardId = jobIdFromDashboardUrl(tab?.url);
  const jobId = dashboardId || settings.lastJobId;
  $('jobId').value = jobId;
  if (dashboardId) await chrome.storage.local.set({ lastJobId: dashboardId });

  const host = safeHost(tab?.url);
  $('fill').textContent = isLoopback(host) ? 'Open application' : 'Start / fill application';
  if (!jobId) return;
  if (settings.key.length < 32) {
    $('jobSummary').textContent = 'Connection key required.';
    return;
  }
  try {
    const payload = await getPayload(settings, jobId);
    $('jobSummary').textContent = `${payload.job.company} — ${payload.job.title}`;
  } catch (error) {
    $('jobSummary').textContent = error.message;
  }
}

$('fill').addEventListener('click', async () => {
  $('fill').disabled = true;
  try {
    const settings = await chrome.storage.local.get({
      serverUrl: 'http://127.0.0.1:4646', key: '', trustedHosts: {},
    });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const jobId = jobIdFromDashboardUrl(tab?.url) || $('jobId').value.trim();
    if (!jobId) throw new Error('Select a job in the Job Agent dashboard first.');
    if (settings.key.length < 32) throw new Error('Configure the extension key first.');
    await chrome.storage.local.set({ lastJobId: jobId });

    show('Loading approved application…');
    const payload = await getPayload(settings, jobId);
    $('jobSummary').textContent = `${payload.job.company} — ${payload.job.title}`;
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open the Job Agent dashboard or an application page first.');

    const expected = safeHost(payload.job.url);
    const actual = safeHost(tab.url);
    if (isLoopback(actual)) {
      show('Opening the approved posting…', true);
      await chrome.tabs.update(tab.id, { url: payload.job.url });
      return;
    }

    const trusted = new Set(settings.trustedHosts?.[jobId] || []);
    if (expected && actual !== expected && !isAggregatorHost(expected) && !trusted.has(actual)) {
      const ok = confirm(`This application moved from ${expected} to ${actual}. Continue only if you reached this site by clicking Apply for this job.`);
      if (!ok) throw new Error('Not filled. Return to the correct employer application.');
    }

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: ['content.js'],
    });
    const targets = [...new Set(injected.map((item) => item.frameId))];
    const results = [];
    for (const frameId of targets) {
      try {
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'JOB_AGENT_FILL', payload,
          connection: {
            serverUrl: settings.serverUrl, key: settings.key,
            allowStart: frameId === 0, expectedHost: expected,
            trustedHost: actual === expected || trusted.has(actual),
          },
        }, { frameId });
        if (result) results.push(result);
      } catch { /* inaccessible frame */ }
    }
    if (!results.length) throw new Error('The browser did not allow access to this page. Reload the page and try again.');

    const main = results.find((r) => r.mainFrame) || results[0];
    const filled = results.flatMap((r) => r.filled || []);
    const blockers = [...new Set(results.flatMap((r) => r.blockers || []))];
    const formDetected = results.some((r) => r.formDetected);
    const readyForReview = results.some((r) => r.readyForReview);
    const contextVerified = results.some((r) => r.contextVerified);
    const startedApplication = results.some((r) => r.startedApplication);

    if (contextVerified && actual && actual !== expected) {
      trusted.add(actual);
      await chrome.storage.local.set({
        trustedHosts: { ...(settings.trustedHosts || {}), [jobId]: [...trusted].slice(-8) },
      });
    }

    const audit = await fetch(`${settings.serverUrl}/api/extension/jobs/${encodeURIComponent(jobId)}/result`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-job-agent-key': settings.key },
      body: JSON.stringify({
        filled, blockers, formDetected, readyForReview, startedApplication,
        contextVerified, observedUrl: main?.observedUrl || tab.url,
        stage: startedApplication ? 'application_started' : formDetected ? 'form_filled' : 'no_form',
      }),
    });
    if (!audit.ok) throw new Error((await audit.json().catch(() => null))?.error || 'Could not synchronize the result.');

    if (startedApplication) {
      show('Application started. When the form loads, click the extension again to fill it.', true);
    } else if (formDetected) {
      show(`Filled ${filled.length} field(s)${blockers.length ? `; ${blockers.length} need review` : ''}. Review this step${readyForReview ? ' and submit manually when ready' : ', continue, then run the extension on the next step'}.`, true);
    } else {
      show(blockers[0] || 'No application form was found. Open the application form and try again.', false);
    }
  } catch (error) {
    show(error.message, false);
  } finally {
    $('fill').disabled = false;
  }
});

async function getPayload(settings, jobId) {
  const response = await fetch(`${settings.serverUrl}/api/extension/jobs/${encodeURIComponent(jobId)}/payload`, {
    headers: { 'x-job-agent-key': settings.key }, cache: 'no-store',
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Job Agent returned HTTP ${response.status}`);
  return payload;
}

function jobIdFromDashboardUrl(value) {
  try {
    const url = new URL(value);
    if (!isLoopback(url.hostname)) return '';
    const match = url.hash.match(/^#job=(.+)$/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch { return ''; }
}
function isLoopback(host) { return host === '127.0.0.1' || host === 'localhost'; }
function isAggregatorHost(host) { return /(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter)\./i.test(host || ''); }
function safeHost(value) { try { return new URL(value).hostname; } catch { return ''; } }
function show(text, ok = null) { $('status').textContent = text; $('status').className = ok === true ? 'ok' : ok === false ? 'error' : ''; }
