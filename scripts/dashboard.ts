/** `pnpm run dashboard` — regenerate output/dashboard.html on demand. */
import { generateDashboard } from '../src/dashboard.js';
import { closeDb } from '../src/db/index.js';

const path = generateDashboard();
closeDb();
console.log(`Dashboard written to ${path}`);
