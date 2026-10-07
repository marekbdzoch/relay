import { api, closeApp, createApp, setupOwner, waitFor } from './helpers.ts';
import { zipSync } from './zz_zip_tmp.ts';
const N = Number(process.env.BENCH_DAYS ?? 250);
const { app } = await createApp();
const owner = await setupOwner(app);
const users = Array.from({ length: 50 }, (_, i) => ({ id: `U${1000 + i}`, name: `u${i}`, real_name: `User ${i}`, profile: { real_name: `User ${i}`, email: `u${i}@x.com` } }));
const channels = Array.from({ length: 20 }, (_, i) => ({ id: `C${100 + i}`, name: i === 0 ? 'general' : `chan-${i}`, is_general: i === 0, created: 1500000000, members: users.map((u) => u.id) }));
const files: Record<string, string> = { 'users.json': JSON.stringify(users), 'channels.json': JSON.stringify(channels) };
let n = 0;
const t0 = 1600000000;
for (const c of channels) {
  for (let d = 0; d < N; d++) {
    const msgs = [];
    for (let k = 0; k < 20; k++) {
      const sec = t0 + d * 86400 + k * 60;
      const m: any = { type: 'message', user: users[(k + d) % 50].id, text: `Message ${n++} about <@${users[k % 50].id}> lorem ipsum dolor sit amet`, ts: `${sec}.000100` };
      if (k % 5 === 1) m.thread_ts = `${t0 + d * 86400}.000100`;
      if (k % 7 === 0) m.reactions = [{ name: '+1', users: [users[1].id, users[2].id], count: 2 }];
      msgs.push(m);
    }
    files[`${c.name}/${new Date((t0 + d * 86400) * 1000).toISOString().slice(0, 10)}.json`] = JSON.stringify(msgs);
  }
}
const data = zipSync(files);
const start = Date.now();
const res = await api(app, owner.token).upload('/api/admin/import/slack', [{ filename: 'e.zip', content: data }], { importFiles: 'false' });
const job = await waitFor(async () => {
  const r = await api(app, owner.token).get(`/api/admin/import/slack/${res.body.jobId}`);
  return r.body.state === 'done' || r.body.state === 'error' ? r.body : null;
}, 300000, 100);
console.log('messages', n, 'import seconds', (Date.now() - start) / 1000, JSON.stringify(job.counts), job.error ?? '');
await closeApp(app);
