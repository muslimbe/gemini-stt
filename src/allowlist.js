import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PATH = './data/access.json';

mkdirSync('./data', { recursive: true });
if (!existsSync(PATH)) writeFileSync(PATH, '[]');
const ids = new Set(JSON.parse(readFileSync(PATH, 'utf8')));

const save = () => writeFileSync(PATH, JSON.stringify([...ids]));

export function add(id) {
  ids.add(id);
  save();
}

export function remove(id) {
  ids.delete(id);
  save();
}

export const has = id => ids.has(id);

export const list = () => [...ids];
