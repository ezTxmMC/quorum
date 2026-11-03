const [platform, architecture] = process.argv.slice(2);
if (process.platform !== platform || process.arch !== architecture) {
  throw new Error(`Rust Chat-Host muss für ${platform}/${architecture} gebaut werden. Dieses Paket auf der Zielplattform bauen; ein Host-Binary für ${process.platform}/${process.arch} darf nicht mitgeliefert werden.`);
}
