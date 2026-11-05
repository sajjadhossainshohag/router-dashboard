import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ settings: { guard: false }, rules: {}, applied: {}, skip: {}, known: {}, usage: {}, events: [] });

export function createStore(file, { delay = 2000 } = {}) {
  let data = EMPTY();
  if (file) {
    try { data = { ...EMPTY(), ...JSON.parse(readFileSync(file, 'utf8')) }; } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
    }
  }
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  }

  if (file) process.on('exit', () => timer && flush());

  return {
    data,
    save() { timer ??= setTimeout(flush, delay); },
    flush,
  };
}
