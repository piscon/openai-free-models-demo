// Copies data/models.json to public/models.json so the static frontend
// also works when hosted without the Worker (plain static preview).
// Run after editing the seed:  npm run seed:sync
import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../data/models.json', import.meta.url), new URL('../public/models.json', import.meta.url));
console.log('public/models.json synced from data/models.json');
