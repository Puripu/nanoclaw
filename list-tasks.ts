
import { initDatabase, getAllTasks } from './src/db.js';

initDatabase();
const tasks = getAllTasks();
console.log(JSON.stringify(tasks, null, 2));
