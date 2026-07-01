// Fixture for the run-as-node test: prints, as JSON, what a script executed via
// clode-main's runAsNodeIfRequested sees — its args (argv.slice(2)) and whether the
// CLODE_SEA_RUN_AS_NODE sentinel was stripped from the environment before it ran.
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  sentinel: process.env.CLODE_SEA_RUN_AS_NODE === undefined ? 'absent' : process.env.CLODE_SEA_RUN_AS_NODE,
  isMain: require.main === module,
}));
