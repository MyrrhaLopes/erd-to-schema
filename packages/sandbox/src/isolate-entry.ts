/**
 * Código que roda DENTRO do isolate V8 (sem nenhuma API do Node): o parse do Drizzle
 * inteiro — sucrase, drizzle-orm e a conversão para o modelo — num bundle só.
 */
import { parseDrizzle } from '@erd/model/formats/drizzle/parse';

type Seeded = { __seed?: number[]; crypto?: { getRandomValues<T extends ArrayBufferView>(a: T): T } };
const g = globalThis as unknown as Seeded;

// o nanoid (IDs das entidades novas) precisa de bytes aleatórios: o host manda uma semente por chamada
if (!g.crypto) {
  g.crypto = {
    getRandomValues<T extends ArrayBufferView>(a: T): T {
      const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = g.__seed?.length ? g.__seed.pop()! : Math.floor(Math.random() * 256);
      return a;
    },
  };
}

(globalThis as unknown as { __erdParse: (text: string) => string }).__erdParse = (text: string) => JSON.stringify(parseDrizzle(text));
