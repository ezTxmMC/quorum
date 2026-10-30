// Einstiegspunkt des Terminal-Bundles (dist-cli/quorum.mjs).
import { main } from './main';

// Leere Pipe am Ausgang (`| head`) ist kein Fehler.
process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => { process.stderr.write(`quorum: ${(err as Error).message}\n`); process.exit(1); },
);
