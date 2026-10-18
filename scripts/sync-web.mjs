// Copies the node's web app (web/index.html of Navplotter-tdeck-plus) into www/ and adds the app bridge.
// Usage: node scripts/sync-web.mjs [path/to/index.html]
// Without a path it downloads the current file from GitHub.
import { readFile, writeFile } from 'node:fs/promises';

const SRC_URL = 'https://raw.githubusercontent.com/digitalimpresys/Navplotter-tdeck-plus/main/web/index.html';
const src = process.argv[2];
const html = src ? await readFile(src, 'utf8') : await (await fetch(SRC_URL)).text();
if (!html.includes('</head>') || !html.includes('</body>')) throw new Error('index.html non riconosciuto');

// The bridge must run before the page script: it points /api and /tiles at the node and starts the alarm service
// The meteo module must run after it: it draws over the page's chart and adds to its waypoints and routes
const out = html.replace('</head>', '<script src="navplotter-bridge.js"></script>\n</head>')
  .replace(/<\/body>(?![\s\S]*<\/body>)/, '<script src="navplotter-meteo.js"></script>\n</body>');
await writeFile(new URL('../www/index.html', import.meta.url), out);
console.log('www/index.html aggiornato da ' + (src || SRC_URL));
