let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input || '{}');
  process.stdout.write(JSON.stringify({
    ok: true,
    slots: {
      characters: ['宁'],
      location: request.text?.includes('灯室') ? '灯室' : null,
      objects: ['钥匙'],
    },
  }));
});
