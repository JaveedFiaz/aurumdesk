// The auto-trader on the server, saving its account to a JSON file so it
// survives restarts. The engine itself is in shared/autotrader.js.

import fs from 'node:fs';
import path from 'node:path';
import { createAutoTrader, paperBroker, LIMITS } from '../shared/autotrader.js';

export { paperBroker, LIMITS };

export function fileStorage(file) {
  return {
    load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null),
    save: (state) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    },
  };
}

export function createPaper({ file = null, ...opts } = {}) {
  return createAutoTrader({ ...opts, storage: file ? fileStorage(file) : null });
}
