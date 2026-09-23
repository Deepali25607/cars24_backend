const { execFile } = require('child_process');

// ================= Antivirus hook (FR9) =================
// Default: no scanner (files are accepted). Two ways to plug one in:
//  1. EMAIL_AV_COMMAND="clamscan --no-summary" — the file path is appended;
//     exit code 0 = clean, anything else = infected/unavailable (rejected).
//  2. setScanner(async (filePath, meta) => ({ clean: boolean, detail }))

let scanner = null;

function setScanner(fn) { scanner = typeof fn === 'function' ? fn : null; }

async function scan(filePath, meta = {}) {
  if (scanner) return scanner(filePath, meta);
  const cmd = process.env.EMAIL_AV_COMMAND;
  if (!cmd) return { clean: true, detail: 'no scanner configured' };
  const [bin, ...args] = cmd.split(/\s+/).filter(Boolean);
  return new Promise((resolve) => {
    execFile(bin, [...args, filePath], { timeout: 60000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ clean: true, detail: String(stdout || '').trim() });
      resolve({ clean: false, detail: String(stdout || stderr || err.message).trim().slice(0, 500) });
    });
  });
}

module.exports = { scan, setScanner };
