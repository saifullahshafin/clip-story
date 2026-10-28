// Polls the system clipboard (any app, not just the browser) once a second.
const ta = document.getElementById('t');
let last = null;

function read() {
  ta.value = '';
  ta.select();
  document.execCommand('paste');
  return ta.value;
}

setInterval(() => {
  let v;
  try { v = read(); } catch { return; }
  if (v && v !== last) {
    last = v;
    chrome.runtime.sendMessage({ type: 'clip', text: v }).catch(() => {});
  }
}, 1000);
