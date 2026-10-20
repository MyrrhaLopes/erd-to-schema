import type { Redis } from 'ioredis';

/**
 * Quem roda o sync bot de cada documento (fase 7). Com uma instância, ela mesma. Com várias
 * (extensão Redis), só uma pode traduzir texto ⇄ modelo: duas traduzindo o mesmo texto
 * criariam entidades em dobro. O líder é eleito por documento com uma chave no Redis que
 * expira sozinha se a instância cair.
 */
export interface Leader {
  /** Tenta ser (ou continuar sendo) o líder do documento */
  acquire(doc: string): Promise<boolean>;
  release(doc: string): Promise<void>;
}

export const localLeader: Leader = {
  acquire: async () => true,
  release: async () => {},
};

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export class RedisLeader implements Leader {
  constructor(
    private readonly redis: Redis,
    private readonly instanceId: string,
    private readonly ttlMs = 15_000,
    private readonly prefix = 'erd:bot-leader:',
  ) {}

  async acquire(doc: string) {
    const key = this.prefix + doc;
    if ((await this.redis.set(key, this.instanceId, 'PX', this.ttlMs, 'NX')) === 'OK') return true;
    return (await this.redis.eval(RENEW, 1, key, this.instanceId, String(this.ttlMs))) === 1;
  }

  async release(doc: string) {
    await this.redis.eval(RELEASE, 1, this.prefix + doc, this.instanceId).catch(() => {});
  }
}
