const [mode]=process.argv.slice(2);

if(mode==='success') {
  process.stdout.write('fixture stdout\n');
  process.stderr.write('fixture stderr\n');
} else if(mode==='nonzero') {
  process.stderr.write('fixture failed\n');
  process.exitCode=23;
} else if(mode==='silent') {
  setTimeout(()=>{},10_000);
} else if(mode==='noisy') {
  process.stdout.write('o'.repeat(50_000));
  process.stderr.write('e'.repeat(50_000));
} else if(mode==='environment') {
  process.stdout.write(JSON.stringify({
    secret:process.env.EODUKSINI_RUNNER_SECRET??null,
    node_options:process.env.NODE_OPTIONS??null
  }));
} else if(mode==='native-signal') {
  setTimeout(()=>process.kill(process.pid,'SIGTERM'),50);
} else {
  process.stderr.write('unknown fixture mode\n');
  process.exitCode=64;
}
