import { Hono } from 'hono';
import type { Deps } from './context';
import { DRIVE_METRICS } from './drive/service';

const http = { requests: 0, errors5xx: 0, rateLimited: 0 };
export const httpMetrics = http;

/**
 * `/metrics` no formato do Prometheus (§15.6): conexões e documentos abertos, tamanho dos
 * documentos, tempo de parse do sync bot, sandbox, updates recusados e o pool do Postgres.
 * O `server` fica na rede privada (o Caddy só repassa /api e /collab), então o endpoint não
 * é público; com `METRICS_TOKEN`, exige `Authorization: Bearer <token>` mesmo assim.
 */
export function metricsRoutes(deps: Pick<Deps, 'env' | 'collab' | 'pool' | 'drive'>) {
  return new Hono().get('/metrics', async (c) => {
    const token = deps.env.METRICS_TOKEN;
    if (token && c.req.header('authorization') !== `Bearer ${token}`) return c.text('unauthorized', 401);
    const lines: string[] = [];
    const g = (name: string, help: string, value: number, labels = '') => {
      if (!lines.some((l) => l.startsWith(`# HELP ${name} `))) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}`);
      lines.push(`${name}${labels} ${value}`);
    };
    const m = deps.collab?.metrics;
    if (m) {
      g('erd_collab_connections', 'WebSockets abertos', m.connections);
      g('erd_collab_documents', 'Documentos carregados em memória', m.documents);
      g('erd_collab_largest_document_bytes', 'Maior estado de documento na última compactação', m.largestDocumentBytes);
      g('erd_collab_stored_bytes_total', 'Bytes de updates gravados no log', m.storedBytes);
      g('erd_collab_rejected_updates_total', 'Updates recusados (tamanho ou taxa)', m.rejectedUpdates);
      g('erd_collab_divergent_patches_total', 'Patches modelo → texto que não encaixaram', m.divergentPatches);
      g('erd_collab_sandbox_timeouts_total', 'Timeouts do sandbox do Drizzle', m.sandboxTimeouts);
      g('erd_collab_sandbox_crashes_total', 'Crashes do sandbox do Drizzle', m.sandboxCrashes);
      g('erd_collab_auto_versions_total', 'Versões automáticas diárias gravadas', m.autoVersions);
      for (const [f, p] of Object.entries(m.parses)) {
        g('erd_sync_parses_total', 'Parses do sync bot por formato', p.count, `{format="${f}"}`);
        g('erd_sync_parse_ms_total', 'Tempo total de parse do sync bot (ms)', p.totalMs, `{format="${f}"}`);
      }
    }
    if (deps.drive) {
      for (const [status, n] of Object.entries(DRIVE_METRICS.publish)) g('drive_publish_total', 'Publicações no Drive por resultado', n, `{status="${status}"}`);
      g('drive_publish_seconds_total', 'Tempo total das publicações no Drive (s)', Math.round(DRIVE_METRICS.publishSecondsTotal * 1000) / 1000);
      g('drive_publish_seconds_count', 'Publicações no Drive cronometradas', DRIVE_METRICS.publishCount);
      g('drive_external_edits_total', 'Edições feitas pelo Drive detectadas', DRIVE_METRICS.externalEdits);
      g('drive_pending_deletions', 'Arquivos antigos ainda por excluir no Drive', await deps.drive.pendingDeletionsCount().catch(() => 0));
    }
    g('erd_http_requests_total', 'Requisições HTTP na API', http.requests);
    g('erd_http_errors_5xx_total', 'Respostas 5xx', http.errors5xx);
    g('erd_http_rate_limited_total', 'Requisições recusadas pelo limite de taxa', http.rateLimited);
    g('erd_pg_pool_total', 'Conexões no pool do Postgres', deps.pool.totalCount);
    g('erd_pg_pool_idle', 'Conexões ociosas no pool', deps.pool.idleCount);
    g('erd_pg_pool_waiting', 'Requisições esperando conexão', deps.pool.waitingCount);
    const mem = process.memoryUsage();
    g('erd_process_rss_bytes', 'Memória residente do processo', mem.rss);
    g('erd_process_heap_used_bytes', 'Heap em uso', mem.heapUsed);
    return c.text(lines.join('\n') + '\n', 200, { 'Content-Type': 'text/plain; version=0.0.4' });
  });
}
