import { run } from './main';

const code = await run(process.argv.slice(2));
process.exitCode = code;
