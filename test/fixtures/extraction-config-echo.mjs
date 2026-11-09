import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line || '{}');
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    slots: { characters: ['宁'], location: '灯室', objects: ['钥匙'], goal: null },
    clusters: [{ clusterId: 'coref:1', canonical: '宁', mentions: [{ text: '宁' }] }],
    srl: {
      words: ['宁', '进', '灯室'],
      verb: { verb: '进', tags: ['B-ARG0', 'B-V', 'B-ARGM-LOC'], frame: 'go.01' },
    },
    links: [{ text: '宁', entityId: 'p:1', score: 0.9 }],
  }) + '\n', () => process.exit(0));
});
