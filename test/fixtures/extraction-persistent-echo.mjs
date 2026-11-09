import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line || '{}');
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    pid: process.pid,
    slots: {
      characters: ['宁'],
      location: request.text?.includes('灯室') ? '灯室' : null,
      objects: ['钥匙'],
    },
  }) + '\n');
});
