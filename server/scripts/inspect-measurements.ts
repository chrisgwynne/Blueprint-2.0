import { inspectMeasurements } from '../tasks/measurement-learning.js';

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 50;
const snapshot = inspectMeasurements(Number.isFinite(limit) && limit > 0 ? limit : 50);

console.log(JSON.stringify(snapshot, null, 2));
