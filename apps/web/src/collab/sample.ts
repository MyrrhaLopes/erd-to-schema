import type { Project } from '@erd/model/types';
import { newId } from '@erd/model/naming';
import { buildSampleProject as build } from '@erd/model/sample';
import { parseInWorker } from '../sync/parserClient';

export function buildSampleProject(): Promise<Project> {
  return build((sql) => parseInWorker('sql', sql), () => newId('n_'));
}
