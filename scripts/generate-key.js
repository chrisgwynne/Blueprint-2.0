import { randomBytes } from 'crypto';
process.stdout.write(randomBytes(32).toString('hex'));
