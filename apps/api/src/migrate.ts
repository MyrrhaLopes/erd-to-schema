// Entrada do `preDeployCommand` (node dist/migrate.js): aplica as migrações antes do container novo receber tráfego
import { runMigrations } from '@erd/db/migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida');
  process.exit(1);
}
runMigrations(url)
  .then(() => {
    console.log('migrações aplicadas');
    process.exit(0);
  })
  .catch((e) => {
    console.error('falha na migração:', e);
    process.exit(1);
  });
