import dotenv from 'dotenv';
dotenv.config();

console.log('--- ENV CHECK ---');
console.log('OVERSEER_URL:', process.env.OVERSEER_URL);
console.log('OVERSEER_API:', process.env.OVERSEER_API ? '[REDACTED]' : 'MISSING');
console.log('OVERSEERR_URL:', process.env.OVERSEERR_URL);
console.log('OVERSEERR_API:', process.env.OVERSEERR_API ? '[REDACTED]' : 'MISSING');
console.log('--- END ENV CHECK ---');
