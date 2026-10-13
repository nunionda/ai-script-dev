import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db';
import { createApp } from './app';
import { aiStatus } from './ai';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8787;
const store = new Store(process.env.FRAME_DB || join(root, 'data', 'frame.db'));
store.seedIfEmpty();

const app = createApp(store);

const dist = join(root, 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(port, () => {
  const ai = aiStatus();
  console.log(`FRAME API  http://localhost:${port}`);
  console.log(ai.configured ? `AI 개발 파트너: ${ai.model}` : 'AI 개발 파트너: 자격 증명 없음 (ANTHROPIC_API_KEY를 설정하면 활성화됩니다)');
});
